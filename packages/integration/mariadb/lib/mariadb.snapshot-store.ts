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
import { type Pool, type PoolConnection, createPool } from 'mariadb';
import type { MariaDBSnapshotEntity, MariaDBSnapshotStoreConfig } from './interfaces/index.js';
import {
	CATALOG_TABLE,
	assertTableName,
	catalogDdl,
	catalogExists,
	escapeId,
	inspectSnapshotTable,
	registerSnapshotTableSql,
	snapshotSchemaRemedy,
	snapshotTableDdl,
	tableColumns,
} from './mariadb.schema.js';
import {
	MariaDBErrorNumber,
	errorNumberOf,
	fromDateTime,
	fromJson,
	inBatches,
	isDuplicateEntryError,
	isFatalConnectionError,
	streamRows,
	toDateTime,
} from './mariadb.utils.js';
import { runMigration } from './migration/migrate.js';

type Entity<A extends AggregateRoot> = MariaDBSnapshotEntity<A>;

/**
 * The version of a snapshot table's schema: 2 stores UTC wall times in a `DATETIME(3)`, 1 is a 3.x table, whose
 * `TIMESTAMP` the connector converts like 3.x did.
 */
type SchemaVersion = 1 | 2;

/**
 * A snapshot store on MariaDB (InnoDB), with schema v2 (ADR 0002 §3).
 *
 * - One flagged (latest) snapshot per stream, which a unique index enforces; the last snapshot of a stream is the one
 *   with the highest version, which is also the flagged one.
 * - `ensureCollection` creates the tables (`ddl: 'auto'`) or checks them (`ddl: 'none'`). A 3.x table keeps working,
 *   with a warning, until `MariaDBSnapshotStore.migrate()` migrates it.
 */
export class MariaDBSnapshotStore extends SnapshotStore<MariaDBSnapshotStoreConfig> {
	private pool: Pool | undefined;

	/** The schema version of the tables this store read or wrote, by table. */
	private readonly schemaVersions = new Map<ISnapshotCollection, SchemaVersion>();

	/**
	 * Migrates the snapshot tables of a 3.x store to schema v2, without a NestJS application: converts every table (or
	 * the tables of `options.pools`) in place and repairs its latest flags. Stop every 3.x instance first.
	 */
	static migrate(
		config: Omit<MariaDBSnapshotStoreConfig, 'driver'>,
		options?: MigrationOptions,
	): Promise<MigrationReport> {
		return runMigration(config, 'snapshots', options);
	}

	/**
	 * Migrates the snapshot tables of this store's database to schema v2, on a connection of its own; see the static
	 * `MariaDBSnapshotStore.migrate()`.
	 */
	async migrate(options?: MigrationOptions): Promise<MigrationReport> {
		try {
			return await runMigration(this.options, 'snapshots', options);
		} finally {
			this.schemaVersions.clear();
		}
	}

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { driver: _driver, useDefaultPool: _useDefaultPool, ddl: _ddl, ...poolConfig } = this.options ?? {};
		const pool = createPool(poolConfig);
		// Makes a bad connection fail the bootstrap
		try {
			await pool.query('SELECT 1');
		} catch (error) {
			await pool.end().catch(() => undefined);
			throw error;
		}
		this.pool = pool;
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
	 * Creates the table of a pool and registers it in the catalog (`ddl: 'auto'`), or checks and registers it
	 * (`ddl: 'none'`). A 3.x table is registered as such and keeps working, with a warning.
	 */
	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);
		const db = this.connected();

		try {
			assertTableName(collection);
			const none = this.options?.ddl === 'none';
			if (none) {
				if (!(await catalogExists(db))) {
					throw new Error(
						`The catalog ${CATALOG_TABLE} doesn't exist and ddl is 'none'. ${snapshotSchemaRemedy(collection)}`,
					);
				}
			} else {
				await db.query(catalogDdl());
			}

			const { state, columns } = await inspectSnapshotTable(db, collection);
			let version: SchemaVersion = 2;
			if (state === 'absent') {
				if (none) {
					throw new Error(
						`The ${collection} table doesn't exist and ddl is 'none'. ${snapshotSchemaRemedy(collection)}`,
					);
				}
				await db.query(snapshotTableDdl(collection));
			} else if (state !== 'v2') {
				version = 1;
				this.logger.warn(
					`The ${collection} table has the 3.x snapshot schema. It keeps working, without the unique latest flag and with registered_on to the second; migrate it with MariaDBSnapshotStore.migrate().`,
				);
			}
			await db.query(registerSnapshotTableSql(collection, version));
			// How registered_on is read and written follows its type: a table that a migration stopped in may have converted it
			this.schemaVersions.set(collection, columns.get('registered_on')?.dataType === 'timestamp' ? 1 : 2);

			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	/** Lists the snapshot collections of the catalog, in binary order. */
	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		let after = '';
		while (true) {
			let rows: { name: ISnapshotCollection }[];
			try {
				rows = await this.connected().query<{ name: ISnapshotCollection }[]>(
					`SELECT name FROM ${escapeId(CATALOG_TABLE)} WHERE kind = 'snapshots' AND name > ? ORDER BY name LIMIT ?`,
					[after, batch],
				);
			} catch (error) {
				if (errorNumberOf(error) === MariaDBErrorNumber.NoSuchTable) {
					return;
				}
				throw error;
			}
			if (rows.length > 0) {
				yield rows.map(({ name }) => name);
			}
			if (rows.length < batch) {
				return;
			}
			after = rows[rows.length - 1].name;
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
	 * Appends a snapshot and flags it as the latest, in one transaction that locks the stream's flagged snapshot first:
	 * appends to a stream serialize there, and the unique index on the flag turns a race on a new stream into a conflict.
	 */
	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const envelope = SnapshotEnvelope.create<A>(snapshot, {
			aggregateId: stream.aggregateId,
			version: aggregateVersion,
		});

		let connection: PoolConnection | undefined;
		let broken = false;
		try {
			const table = escapeId(collection);
			const payload = JSON.stringify(envelope.payload);
			const version = await this.schemaVersionOf(collection);
			const registeredOn = version === 2 ? toDateTime(envelope.metadata.registeredOn) : envelope.metadata.registeredOn;
			const latest = `latest#${stream.streamId}`;

			connection = await this.connected().getConnection();
			// READ COMMITTED: no gap locks, so appends that race on a new stream end on the unique index, not in a deadlock
			const [, , [flagged]] = await Promise.all([
				connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'),
				connection.query('START TRANSACTION'),
				connection.query<{ version: number }[]>(
					`SELECT version FROM ${table} WHERE aggregate_name = ? AND latest = ? FOR UPDATE`,
					[stream.aggregate, latest],
				),
			]);

			if (flagged && aggregateVersion <= flagged.version) {
				throw new SnapshotStoreVersionConflictException({
					stream,
					version: aggregateVersion,
					latestVersion: flagged.version,
					pool,
				});
			}
			if (flagged) {
				// Assigning registered_on to itself keeps a legacy ON UPDATE attribute (3.x tables) from firing
				await connection.query(
					`UPDATE ${table} SET latest = NULL, registered_on = registered_on WHERE stream_id = ? AND version = ?`,
					[stream.streamId, flagged.version],
				);
			}
			await connection.query(
				`INSERT INTO ${table} (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					stream.streamId,
					envelope.metadata.version,
					payload,
					envelope.metadata.snapshotId,
					envelope.metadata.aggregateId,
					registeredOn,
					stream.aggregate,
					latest,
				],
			);
			await connection.commit();

			return envelope;
		} catch (error) {
			broken = isFatalConnectionError(error);
			await connection?.rollback().catch(() => {
				broken = true;
			});

			if (error instanceof SnapshotStoreVersionConflictException) {
				throw error;
			}
			// Another append took the version, or flagged its snapshot first
			if (isDuplicateEntryError(error)) {
				const latestVersion = connection ? await this.latestVersionOf(collection, stream, connection) : undefined;
				throw new SnapshotStoreVersionConflictException(
					{ stream, version: aggregateVersion, latestVersion, pool },
					{ cause: error },
				);
			}
			throw new SnapshotStorePersistenceException({ collection }, { cause: error });
		} finally {
			if (connection) {
				if (broken) {
					await connection.destroy();
				} else {
					await connection.release();
				}
			}
		}
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

	/** The snapshot with the highest version of the stream. */
	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void> {
		const collection = SnapshotCollection.get(pool);
		const [entity] = await this.connected().query<Entity<A>[]>(
			`SELECT ${await this.columnsOf(collection)} FROM ${escapeId(collection)} WHERE stream_id = ? ORDER BY version DESC LIMIT 1`,
			[streamId],
		);
		if (entity) {
			return toSnapshotEnvelope(entity);
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
			SELECT ${await this.columnsOf(collection)}
			FROM ${escapeId(collection)}
			WHERE stream_id = ?
			${fromVersion ? 'AND version >= ?' : ''}
			ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
			LIMIT ?
		`;
		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		yield* inBatches(this.envelopesOf<A>(streamRows<Entity<A>>(this.connected(), query, params)), batch);
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const [entity] = await this.connected().query<Entity<A>[]>(
			`SELECT ${await this.columnsOf(collection)} FROM ${escapeId(collection)} WHERE stream_id = ? AND version = ?`,
			[streamId, version],
		);
		if (!entity) {
			throw new SnapshotNotFoundException({ streamId, version, pool });
		}
		return toSnapshotEnvelope(entity);
	}

	/**
	 * The latest snapshot of every stream of an aggregate, in descending binary order of the aggregate ids;
	 * `filter.aggregateId` is an exclusive cursor.
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

		// The latest keys of an aggregate differ in their aggregate id only, so their order is the order of the ids
		const query = `
			SELECT ${await this.columnsOf(collection)}
			FROM ${escapeId(collection)}
			WHERE aggregate_name = ? AND latest IS NOT NULL
			${aggregateId ? 'AND latest < ?' : ''}
			ORDER BY latest DESC
			LIMIT ?
		`;
		const params = aggregateId ? [streamName, `latest#${streamName}-${aggregateId}`, limit] : [streamName, limit];

		yield* inBatches(this.envelopesOf<A>(streamRows<Entity<A>>(this.connected(), query, params)), batch);
	}

	/** The snapshot with the highest version of every stream that has one. */
	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const envelopes = new Map<SnapshotStream, SnapshotEnvelope<A>>();
		// `IN ()` is invalid SQL, and an empty list of streams has no snapshots anyway
		if (streams.length === 0) {
			return envelopes;
		}

		const collection = SnapshotCollection.get(pool);
		const table = escapeId(collection);
		const entities = await this.connected().query<Entity<A>[]>(
			`SELECT ${await this.columnsOf(collection, 's.')}
			 FROM ${table} s JOIN (
				SELECT stream_id, MAX(version) AS version FROM ${table} WHERE stream_id IN (?) GROUP BY stream_id
			 ) l ON s.stream_id = l.stream_id AND s.version = l.version`,
			[streams.map(({ streamId }) => streamId)],
		);

		const byStreamId = new Map(streams.map((stream) => [stream.streamId, stream]));
		for (const entity of entities) {
			const stream = byStreamId.get(entity.stream_id);
			if (stream) {
				envelopes.set(stream, toSnapshotEnvelope(entity));
			}
		}
		return envelopes;
	}

	/** The columns of a snapshot, with `registered_on` as UTC wall time text from a schema v2 table. */
	private async columnsOf(collection: ISnapshotCollection, alias = ''): Promise<string> {
		const registeredOn =
			(await this.schemaVersionOf(collection)) === 2
				? `CAST(${alias}registered_on AS CHAR) AS registered_on`
				: `${alias}registered_on`;
		return ['stream_id', 'version', 'payload', 'snapshot_id', 'aggregate_id', 'aggregate_name']
			.map((column) => `${alias}${column}`)
			.concat(registeredOn)
			.join(', ');
	}

	/**
	 * The schema version of a table: known once the store ensured or used it, otherwise read from the type of its
	 * `registered_on`. A table that doesn't exist counts as schema v2, and its reads fail.
	 */
	private async schemaVersionOf(collection: ISnapshotCollection): Promise<SchemaVersion> {
		const known = this.schemaVersions.get(collection);
		if (known) {
			return known;
		}
		const registeredOn = (await tableColumns(this.connected(), collection)).get('registered_on');
		if (!registeredOn) {
			return 2;
		}
		const version: SchemaVersion = registeredOn.dataType === 'timestamp' ? 1 : 2;
		this.schemaVersions.set(collection, version);
		return version;
	}

	private async *envelopesOf<A extends AggregateRoot>(
		rows: AsyncIterable<Entity<A>>,
	): AsyncGenerator<SnapshotEnvelope<A>> {
		for await (const row of rows) {
			yield toSnapshotEnvelope(row);
		}
	}

	/**
	 * Best effort lookup of the latest snapshot version of a stream, used to report a conflict.
	 */
	private async latestVersionOf(
		collection: ISnapshotCollection,
		{ streamId }: SnapshotStream,
		connection: PoolConnection,
	): Promise<number | undefined> {
		try {
			const [result] = await connection.query<{ version: number | null }[]>(
				`SELECT MAX(version) AS version FROM ${escapeId(collection)} WHERE stream_id = ?`,
				[streamId],
			);
			return result?.version ?? undefined;
		} catch {
			return undefined;
		}
	}

	private connected(): Pool {
		if (!this.pool) {
			throw new Error(`${this.constructor.name} is not connected: call connect() first`);
		}
		return this.pool;
	}
}

const toSnapshotEnvelope = <A extends AggregateRoot>({
	payload,
	aggregate_id,
	registered_on,
	snapshot_id,
	version,
}: Entity<A>): SnapshotEnvelope<A> =>
	SnapshotEnvelope.from<A>(fromJson(payload), {
		aggregateId: aggregate_id,
		// Text from a schema v2 table, a Date the connector converted from a 3.x TIMESTAMP
		registeredOn: fromDateTime(registered_on),
		snapshotId: snapshot_id,
		version: Number(version),
	});
