import type { Type } from '@nestjs/common';
import {
	type AggregateRoot,
	DEFAULT_BATCH_SIZE,
	type ILatestSnapshotFilter,
	type ISnapshot,
	type ISnapshotCollection,
	type ISnapshotCollectionFilter,
	type ISnapshotFilter,
	type ISnapshotPool,
	type MigrationOptions,
	type MigrationReport,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	type SnapshotStream,
	StreamReadingDirection,
	getAggregateMetadata,
} from '@ocoda/event-sourcing';
import { type Pool, type PoolClient, escapeIdentifier } from 'pg';
import type { PostgresSnapshotEntity, PostgresSnapshotStoreConfig } from './interfaces/index.js';
import { runMigration } from './migration/migrate.js';
import { UNDEFINED_TABLE, UNIQUE_VIOLATION, hasErrorCode, readInBatches, withTransaction } from './postgres.helpers.js';
import { createPool, migrationPoolConfigOf, poolConfigOf } from './postgres.pool.js';
import {
	CATALOG,
	SCHEMA_VERSION,
	assertTableName,
	catalogStatement,
	describeTable,
	ensureCatalog,
	registerSnapshotsStatement,
	renderStatements,
	snapshotTableState,
	snapshotTableStatements,
} from './postgres.schema.js';

type PostgresSnapshotEnvelopeEntity<A extends AggregateRoot> = Pick<
	PostgresSnapshotEntity<A>,
	'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'
>;

const ENVELOPE_COLUMNS = 'payload, aggregate_id, registered_on, snapshot_id, version';

/**
 * A snapshot store on PostgreSQL (schema v2, ADR 0002 §2).
 *
 * Every pool has its own table (`snapshots`, `<pool>-snapshots`), registered in the `event_sourcing_collections`
 * catalog of the schema. The last snapshot of a stream is the one with the highest version; it also carries the
 * stream's `latest` flag, which a unique index keeps to one row per stream.
 *
 * A 3.x table keeps working (with a warning) until it is migrated with `PostgresSnapshotStore.migrate()`.
 */
export class PostgresSnapshotStore extends SnapshotStore<PostgresSnapshotStoreConfig> {
	private pool: Pool | undefined;

	/**
	 * The 3.x tables this store already warned about.
	 */
	private readonly warnedLegacyTables = new Set<ISnapshotCollection>();

	/**
	 * Migrates the snapshot tables of a 3.x store to schema v2, without a Nest application. Migrate the event tables
	 * first. Stop every 3.x instance first; with `dryRun: true` it only reports.
	 * See the [migration runbook](https://ocoda.github.io/event-sourcing/integrations/postgres#migrating-from-3x).
	 */
	static async migrate(
		config: Omit<PostgresSnapshotStoreConfig, 'driver'>,
		options?: MigrationOptions,
	): Promise<MigrationReport> {
		const pool = createPool(migrationPoolConfigOf(config), () => undefined);
		try {
			return await runMigration(pool, 'snapshots', options);
		} finally {
			await pool.end();
		}
	}

	/**
	 * Migrates the snapshot tables of a 3.x store to schema v2, on this connected store. See the static `migrate`.
	 */
	async migrate(options?: MigrationOptions): Promise<MigrationReport> {
		return runMigration(this.connection, 'snapshots', options, this.logger);
	}

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.pool = createPool(poolConfigOf(this.options), (error) =>
			this.logger.error(`Idle database connection failed: ${error.message}`),
		);

		// Fail fast when the database can't be reached
		const client = await this.pool.connect();
		client.release();
	}

	public async disconnect(): Promise<void> {
		const pool = this.pool;
		if (!pool) {
			return;
		}
		this.logger.log('Stopping store');
		this.pool = undefined;
		await pool.end();
	}

	/**
	 * Creates the table of a pool and registers it in the catalog, unless it exists. A 3.x table is registered with
	 * schema version 1 and keeps working, with a warning to migrate it.
	 */
	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);
		const ddl = this.options.ddl ?? 'auto';

		try {
			assertTableName(collection);
			if (!(await ensureCatalog(this.connection, ddl === 'auto'))) {
				throw new Error(
					`The ${CATALOG} catalog doesn't exist, and ddl is 'none': create it with ${renderStatements([catalogStatement(), ...snapshotTableStatements(collection)])}`,
				);
			}

			await withTransaction(this.connection, async (client) => {
				await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [collection]);
				const table = await describeTable(client, collection);
				const state = snapshotTableState(table);

				let schemaVersion = SCHEMA_VERSION;
				if (state === 'absent') {
					if (ddl === 'none') {
						throw new Error(
							`The ${collection} table doesn't exist, and ddl is 'none': create it with ${renderStatements(snapshotTableStatements(collection))}`,
						);
					}
					for (const statement of snapshotTableStatements(collection)) {
						await client.query(statement);
					}
				} else if (state !== 'v2') {
					schemaVersion = 1;
					if (!this.warnedLegacyTables.has(collection)) {
						this.warnedLegacyTables.add(collection);
						const schema =
							state === 'v1'
								? 'has the 3.x snapshot schema'
								: 'lacks parts of snapshot schema v2 (such as the unique index on its latest flags)';
						this.logger.warn(
							`Collection ${collection} ${schema}, which doesn't keep a single latest snapshot per stream when appends race. It keeps working; migrate it with PostgresSnapshotStore.migrate(config, { dryRun: true }), then migrate().`,
						);
					}
				}

				await client.query(registerSnapshotsStatement(), [collection, schemaVersion]);
			});

			return collection;
		} catch (err) {
			throw new SnapshotStoreCollectionCreationException({ collection }, { cause: err });
		}
	}

	/**
	 * Lists the snapshot collections registered in the catalog, by name, in batches.
	 */
	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		let after: string | null = null;

		while (true) {
			let names: ISnapshotCollection[];
			try {
				const { rows } = await this.connection.query<{ name: ISnapshotCollection }>(
					`SELECT name FROM ${CATALOG}
					WHERE kind = 'snapshots' AND ($1::text IS NULL OR name > $1)
					ORDER BY name LIMIT $2`,
					[after, batch],
				);
				names = rows.map(({ name }) => name);
			} catch (error) {
				// No catalog, so no collections
				if (hasErrorCode(error, UNDEFINED_TABLE)) {
					return;
				}
				throw error;
			}

			if (names.length === 0) {
				return;
			}
			yield names;
			if (names.length < batch) {
				return;
			}
			after = names[names.length - 1];
		}
	}

	async *getSnapshots<A extends AggregateRoot>(
		stream: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		for await (const envelopes of this.getEnvelopes<A>(stream, filter)) {
			yield envelopes.map(({ payload }) => payload);
		}
	}

	async getSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		return (await this.getEnvelope<A>(stream, version, pool)).payload;
	}

	/**
	 * Appends a snapshot and moves the stream's `latest` flag to it. Appends to a stream serialize on an advisory lock,
	 * and a snapshot must have a higher version than every snapshot of its stream.
	 */
	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const table = escapeIdentifier(collection);

		try {
			// The version check, flag update and insert run in one transaction, so they either all apply or none do
			return await withTransaction(this.connection, async (client) => {
				// Serialize appends to the same stream, so concurrent writers can't both claim the 'latest' flag
				await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [collection, stream.streamId]);

				const envelope = SnapshotEnvelope.create<A>(snapshot, {
					aggregateId: stream.aggregateId,
					version: aggregateVersion,
				});

				const lastVersion = await this.getLastVersion(client, table, stream);

				if (lastVersion !== undefined && aggregateVersion <= lastVersion) {
					throw new SnapshotStoreVersionConflictException({
						stream,
						version: aggregateVersion,
						latestVersion: lastVersion,
						pool,
					});
				}

				if (lastVersion !== undefined) {
					// Unflags every snapshot of the stream, which also repairs a 3.x stream with several flags
					await client.query(`UPDATE ${table} SET latest = NULL WHERE stream_id = $1 AND latest IS NOT NULL`, [
						stream.streamId,
					]);
				}

				await client.query(
					`INSERT INTO ${table} (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
					[
						stream.streamId,
						envelope.metadata.version,
						JSON.stringify(envelope.payload),
						envelope.metadata.snapshotId,
						envelope.metadata.aggregateId,
						// A Date, which pg sends as local time with its offset: exact in a TIMESTAMPTZ column, and the wall
						// time of the process in a 3.x TIMESTAMP column, as 3.x wrote it
						envelope.metadata.registeredOn,
						stream.aggregate,
						latestKey(stream.streamId),
					],
				);

				return envelope;
			});
		} catch (error) {
			if (error instanceof SnapshotStoreVersionConflictException) {
				throw error;
			}

			// A writer that doesn't take the stream lock appended the same version, or flagged the stream, concurrently
			if (hasErrorCode(error, UNIQUE_VIOLATION)) {
				const latestVersion = await this.getLastVersion(this.connection, table, stream).catch(() => undefined);
				throw new SnapshotStoreVersionConflictException(
					{ stream, version: aggregateVersion, latestVersion, pool },
					{ cause: error },
				);
			}

			throw new SnapshotStorePersistenceException({ collection }, { cause: error });
		}
	}

	/**
	 * The highest version of the snapshots of a stream.
	 */
	private async getLastVersion(
		connection: Pick<PoolClient, 'query'>,
		table: string,
		{ streamId }: SnapshotStream,
	): Promise<number | undefined> {
		const { rows } = await connection.query<{ version: number | null }>(
			`SELECT MAX(version) AS version FROM ${table} WHERE stream_id = $1`,
			[streamId],
		);

		return rows[0]?.version ?? undefined;
	}

	async getLastSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A> | void> {
		return (await this.getLastEnvelope<A>(stream, pool))?.payload;
	}

	async getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const envelopes = await this.getManyLastSnapshotEnvelopes<A>(streams, pool);
		return new Map([...envelopes].map(([stream, { payload }]) => [stream, payload]));
	}

	/**
	 * The snapshot with the highest version of the stream.
	 */
	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void> {
		const collection = SnapshotCollection.get(pool);

		const { rows } = await this.connection.query<PostgresSnapshotEnvelopeEntity<A>>(
			`SELECT ${ENVELOPE_COLUMNS} FROM ${escapeIdentifier(collection)}
			WHERE stream_id = $1 ORDER BY version DESC LIMIT 1`,
			[streamId],
		);

		if (rows[0]) {
			return toEnvelope(rows[0]);
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
	        SELECT ${ENVELOPE_COLUMNS}
	        FROM ${escapeIdentifier(collection)}
	        WHERE stream_id = $1
	        ${fromVersion ? 'AND version >= $2' : ''}
	        ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
	        LIMIT ${fromVersion ? '$3' : '$2'}
	    `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		for await (const rows of readInBatches<PostgresSnapshotEnvelopeEntity<A>>(this.connection, query, params, batch)) {
			yield rows.map((row) => toEnvelope(row));
		}
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const { rows: entities } = await this.connection.query<PostgresSnapshotEnvelopeEntity<A>>(
			`SELECT ${ENVELOPE_COLUMNS} FROM ${escapeIdentifier(collection)} WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

		if (!entity) {
			throw new SnapshotNotFoundException({ streamId, version, pool });
		}

		return toEnvelope(entity);
	}

	/**
	 * The last snapshot of every stream of an aggregate, in descending binary order of the aggregate ids, from the
	 * `latest` flags. `filter.aggregateId` is an exclusive cursor. Compares bytes (`COLLATE "C"`), also on a 3.x table
	 * whose column has the database's collation.
	 */
	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);
		const { streamName } = getAggregateMetadata(aggregate);

		const aggregateId = filter?.aggregateId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT ${ENVELOPE_COLUMNS}
            FROM ${escapeIdentifier(collection)}
            WHERE aggregate_name = $1 AND latest IS NOT NULL
            ${aggregateId ? 'AND latest COLLATE "C" < $3' : ''}
            ORDER BY latest COLLATE "C" DESC
            LIMIT $2
        `;

		const params = aggregateId ? [streamName, limit, latestKey(`${streamName}-${aggregateId}`)] : [streamName, limit];

		for await (const rows of readInBatches<PostgresSnapshotEnvelopeEntity<A>>(this.connection, query, params, batch)) {
			yield rows.map((row) => toEnvelope(row));
		}
	}

	/**
	 * The snapshot with the highest version of each stream, in one query.
	 */
	override async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const envelopes = new Map<SnapshotStream, SnapshotEnvelope<A>>();
		if (streams.length === 0) {
			return envelopes;
		}
		const collection = SnapshotCollection.get(pool);

		const { rows } = await this.connection.query<PostgresSnapshotEnvelopeEntity<A> & { stream_id: string }>(
			`SELECT DISTINCT ON (stream_id) stream_id, ${ENVELOPE_COLUMNS}
			FROM ${escapeIdentifier(collection)}
			WHERE stream_id = ANY ($1)
			ORDER BY stream_id, version DESC`,
			[streams.map(({ streamId }) => streamId)],
		);

		const byStreamId = new Map(rows.map((row) => [row.stream_id, row]));
		for (const stream of streams) {
			const row = byStreamId.get(stream.streamId);
			if (row) {
				envelopes.set(stream, toEnvelope(row));
			}
		}
		return envelopes;
	}

	/**
	 * The pool of the connected store.
	 */
	private get connection(): Pool {
		if (!this.pool) {
			throw new Error(`${this.constructor.name} is not connected: call connect() first`);
		}
		return this.pool;
	}
}

/**
 * The `latest` flag of a stream's last snapshot.
 */
const latestKey = (streamId: string): string => `latest#${streamId}`;

const toEnvelope = <A extends AggregateRoot>({
	payload,
	aggregate_id,
	registered_on,
	snapshot_id,
	version,
}: PostgresSnapshotEnvelopeEntity<A>): SnapshotEnvelope<A> =>
	SnapshotEnvelope.from<A>(payload, {
		aggregateId: aggregate_id,
		registeredOn: registered_on,
		snapshotId: snapshot_id,
		version,
	});
