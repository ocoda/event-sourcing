import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	type EventEnvelopeMetadata,
	EventId,
	EventNotFoundException,
	EventSourcingErrorCode,
	EventStore,
	type EventStoreCapabilities,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreSchemaException,
	type EventStream,
	type IEventCollection,
	type IEventCollectionFilter,
	type IEventFilter,
	type IEventPool,
	type IReadAllFilter,
	type MigrationOptions,
	type MigrationReport,
	type PersistOutcome,
	type PersistTarget,
	StreamReadingDirection,
	isEventSourcingError,
	toBatchSize,
	toPosition,
} from '@ocoda/event-sourcing';
import { DatabaseError, Pool, type PoolClient, escapeIdentifier } from 'pg';
import type { PostgresEventEntity, PostgresEventStoreConfig } from './interfaces/index.js';
import { runMigration } from './migration/migrate.js';
import {
	UNDEFINED_COLUMN,
	UNDEFINED_TABLE,
	UNIQUE_VIOLATION,
	hasErrorCode,
	readInBatches,
	withTransaction,
} from './postgres.helpers.js';
import { createPool, migrationPoolConfigOf, poolConfigOf } from './postgres.pool.js';
import {
	CATALOG,
	assertTableName,
	catalogStatement,
	describeTable,
	ensureCatalog,
	eventTableState,
	eventTableStatements,
	findPositionIndex,
	positionIndexStatement,
	registerEventsStatement,
	renderStatements,
} from './postgres.schema.js';

type PostgresEnvelopeEntity = Omit<PostgresEventEntity, 'stream_id'>;

/**
 * The columns of an envelope, with the position as text: a `BIGINT` doesn't always fit a number, and no global type
 * parser is installed.
 */
const ENVELOPE_COLUMNS =
	'event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id, global_position::text AS global_position, headers, event_version';

/**
 * Appends a batch of envelopes in one statement. The counter update is the first write of the transaction, and its row
 * lock is held until the transaction ends: an append that allocates later positions waits until this one committed or
 * rolled back, so appends commit in the order of their positions, and a rollback returns the positions (no holes).
 * The positions are `last_position - n + 1` to `last_position`, in the order of the envelopes. `unnest` keeps the
 * statement at 13 parameters, whatever the number of events.
 *
 * No row when the pool isn't registered in the catalog: nothing is inserted then.
 */
const appendStatement = (table: string): string => `WITH counter AS (
	UPDATE ${CATALOG} SET last_position = last_position + $12
	WHERE name = $13 AND kind = 'events'
	RETURNING last_position
), inserted AS (
	INSERT INTO ${escapeIdentifier(table)} (stream_id, version, event, payload, event_id, aggregate_id, occurred_on,
		correlation_id, causation_id, global_position, headers, event_version)
	SELECT e.stream_id, e.version, e.event, e.payload, e.event_id, e.aggregate_id, e.occurred_on,
		e.correlation_id, e.causation_id, counter.last_position - $12 + e.ordinality, e.headers, e.event_version
	FROM counter, unnest($1::text[], $2::int[], $3::text[], $4::jsonb[], $5::text[], $6::text[], $7::timestamptz[],
		$8::text[], $9::text[], $10::jsonb[], $11::int[]) WITH ORDINALITY
		AS e(stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id,
			headers, event_version, ordinality)
	RETURNING 1
)
SELECT last_position::text AS last_position, (SELECT count(*) FROM inserted)::int AS inserted FROM counter`;

const MIGRATE_REMEDY = 'Run PostgresEventStore.migrate(config, { dryRun: true }), review the report, then migrate().';

/**
 * An event store on PostgreSQL (schema v2, ADR 0002 §2).
 *
 * Every pool has its own table (`events`, `<pool>-events`), registered in the `event_sourcing_collections` catalog of
 * the schema, which also counts the global positions of each pool. Appends to a pool serialize on its counter row, so
 * the global order is gap-safe: a reader that tails `readAll` never skips an event that commits later.
 */
export class PostgresEventStore extends EventStore<PostgresEventStoreConfig> {
	override readonly capabilities: EventStoreCapabilities = {
		atomicAppend: true,
		headers: true,
		globalOrder: 'gap-safe',
	};

	private pool: Pool | undefined;

	/**
	 * The names of the primary key constraints of each table, read on its first unique violation, to tell a version
	 * conflict from a duplicate position.
	 */
	private readonly primaryKeys = new Map<IEventCollection, ReadonlySet<string>>();

	/**
	 * Migrates the event tables of a 3.x store to schema v2, without a Nest application: inspects them, plans the steps
	 * and runs them, one table per transaction. Stop every 3.x instance first; with `dryRun: true` it only reports.
	 * See the [migration runbook](https://ocoda.github.io/event-sourcing/integrations/postgres#migrating-from-3x).
	 */
	static async migrate(
		config: Omit<PostgresEventStoreConfig, 'driver'>,
		options?: MigrationOptions,
	): Promise<MigrationReport> {
		const pool = createPool(migrationPoolConfigOf(config), () => undefined);
		try {
			return await runMigration(pool, 'events', options);
		} finally {
			await pool.end();
		}
	}

	/**
	 * Migrates the event tables of a 3.x store to schema v2, on this connected store. See the static `migrate`.
	 */
	async migrate(options?: MigrationOptions): Promise<MigrationReport> {
		return runMigration(this.connection, 'events', options, this.logger);
	}

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		// Idle connections that fail are discarded by the pool, without a listener the error would crash the process
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
	 * Creates the table of a pool and registers it in the catalog, unless it exists. On an existing v2 table, registers
	 * it and heals the position counter. Never migrates a 3.x table: that throws an `EventStoreSchemaException`, like a
	 * missing table or catalog with `ddl: 'none'`.
	 */
	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);
		const ddl = this.options.ddl ?? 'auto';

		try {
			assertTableName(collection);
			if (!(await ensureCatalog(this.connection, ddl === 'auto'))) {
				throw new EventStoreSchemaException({
					collection,
					found: 'missing',
					remedy: `The ${CATALOG} catalog doesn't exist either, and ddl is 'none': create both with ${renderStatements([catalogStatement(), ...eventTableStatements(collection)])} Then call ensureCollection() again, which registers the table.`,
				});
			}

			await withTransaction(this.connection, async (client) => {
				// Serializes the stores that ensure the same collection at the same time
				await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [collection]);
				const table = await describeTable(client, collection);

				switch (eventTableState(table)) {
					case 'absent':
						if (ddl === 'none') {
							throw new EventStoreSchemaException({
								collection,
								found: 'missing',
								remedy: `ddl is 'none': create it with ${renderStatements(eventTableStatements(collection))} Then call ensureCollection() again, which registers it.`,
							});
						}
						for (const statement of eventTableStatements(collection)) {
							await client.query(statement);
						}
						break;
					case 'v2':
						if (!findPositionIndex(table)) {
							await this.ensurePositionIndex(client, collection, ddl);
						}
						break;
					case 'v1':
						throw new EventStoreSchemaException({ collection, found: 'v1', remedy: MIGRATE_REMEDY });
					default:
						throw new EventStoreSchemaException({ collection, found: 'v1-partial', remedy: MIGRATE_REMEDY });
				}

				await client.query(registerEventsStatement(collection), [collection]);
			});

			return collection;
		} catch (error) {
			if (isEventSourcingError(error, EventSourcingErrorCode.EventStoreSchema)) {
				throw error;
			}
			throw new EventStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	/**
	 * Lists the event collections registered in the catalog, by name, in batches.
	 */
	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		let after: string | null = null;

		while (true) {
			let names: IEventCollection[];
			try {
				const { rows } = await this.connection.query<{ name: IEventCollection }>(
					`SELECT name FROM ${CATALOG}
					WHERE kind = 'events' AND schema_version = 2 AND ($1::text IS NULL OR name > $1)
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

	public async getStreamVersion({ streamId }: EventStream, pool?: IEventPool): Promise<number> {
		const collection = EventCollection.get(pool);
		try {
			const { rows } = await this.connection.query<{ version: number }>(
				`SELECT COALESCE(MAX(version), 0) AS version FROM ${escapeIdentifier(collection)} WHERE stream_id = $1`,
				[streamId],
			);
			return rows[0].version;
		} catch (error) {
			throw this.readError(error, collection, pool);
		}
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		let entities: PostgresEnvelopeEntity[];
		try {
			({ rows: entities } = await this.connection.query<PostgresEnvelopeEntity>(
				`SELECT ${ENVELOPE_COLUMNS} FROM ${escapeIdentifier(collection)} WHERE stream_id = $1 AND version = $2`,
				[streamId, version],
			));
		} catch (error) {
			throw this.readError(error, collection, pool);
		}
		const entity = entities[0];

		if (!entity) {
			throw new EventNotFoundException({ streamId, version, pool });
		}

		return toEnvelope(entity);
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const pool = filter?.pool;
		const collection = EventCollection.get(pool);

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

		try {
			for await (const rows of readInBatches<PostgresEnvelopeEntity>(this.connection, query, params, batch)) {
				yield rows.map(toEnvelope);
			}
		} catch (error) {
			// Only the read's own failures get here: a consumer that stops or throws closes the read instead
			throw this.readError(error, collection, pool);
		}
	}

	/**
	 * Reads a pool in the order of the global positions, in keyset batches: each batch is its own statement, and no
	 * connection is held while a batch is consumed. A batch only holds committed events, and commits happen in the order
	 * of the positions, so a reader that resumes after the last position it read never skips an event.
	 */
	public async *readAll(filter?: IReadAllFilter): AsyncGenerator<EventEnvelope[]> {
		const pool = filter?.pool;
		const collection = EventCollection.get(pool);
		const batch = toBatchSize(filter?.batch);
		let fromPosition = filter?.fromPosition === undefined ? 0n : toPosition(filter.fromPosition);

		// Qualified: `ORDER BY global_position` alone would sort by the text column of the select list
		const query = `SELECT ${ENVELOPE_COLUMNS} FROM ${escapeIdentifier(collection)} e
			WHERE e.global_position >= $1 ORDER BY e.global_position LIMIT $2`;

		while (true) {
			let entities: PostgresEnvelopeEntity[];
			try {
				({ rows: entities } = await this.connection.query<PostgresEnvelopeEntity>(query, [
					fromPosition.toString(),
					batch,
				]));
			} catch (error) {
				throw this.readError(error, collection, pool);
			}

			if (entities.length === 0) {
				return;
			}
			const envelopes = entities.map(toEnvelope);
			yield envelopes;
			if (entities.length < batch) {
				return;
			}
			fromPosition = (envelopes[envelopes.length - 1].metadata.globalPosition as bigint) + 1n;
		}
	}

	/**
	 * Stores the envelopes of an append in one transaction, and allocates their positions from the pool's counter row
	 * (see `appendStatement`).
	 *
	 * - The rows are encoded before a connection is taken: a payload that can't be serialized fails `'not-persisted'`.
	 * - Every failure before `COMMIT` is sent rolls back and is `'not-persisted'`; a duplicate `(stream_id, version)` is
	 *   a conflict, a duplicate position means the counter drifted (`ensureCollection()` heals it).
	 * - A failure of the `COMMIT` itself is `'unknown'` when the connection was lost, since the commit may have happened.
	 */
	protected override async persistEvents(
		envelopes: readonly EventEnvelope[],
		{ stream, collection, pool }: PersistTarget,
	): Promise<PersistOutcome> {
		const notPersisted = (cause: unknown) =>
			new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause });

		let parameters: unknown[];
		try {
			parameters = [...encodeRows(stream, envelopes), envelopes.length, collection];
		} catch (error) {
			throw notPersisted(error);
		}

		let client: PoolClient;
		try {
			client = await this.connection.connect();
		} catch (error) {
			throw notPersisted(error);
		}

		// A connection that failed is discarded instead of being returned to the pool
		let broken: Error | undefined;
		const onError = (error: Error) => {
			broken ??= error;
		};
		client.on('error', onError);

		let committing = false;
		let failure: unknown;
		try {
			await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
			const {
				rows: [result],
			} = await client.query<{ last_position: string; inserted: number }>(appendStatement(collection), parameters);
			if (!result || result.inserted !== envelopes.length) {
				// The pool isn't registered in the catalog (never ensured, or not migrated): nothing was inserted
				await rollback(client).catch(onError);
				throw notPersisted(new EventCollectionNotFoundException({ collection, pool }));
			}

			committing = true;
			await client.query('COMMIT');

			const last = BigInt(result.last_position);
			const first = last - BigInt(envelopes.length) + 1n;
			return { status: 'committed', positions: envelopes.map((_, index) => first + BigInt(index)) };
		} catch (error) {
			if (isEventSourcingError(error, EventSourcingErrorCode.EventStorePersistence)) {
				throw error;
			}
			if (!isRejectedStatement(error)) {
				broken ??= error instanceof Error ? error : new Error(String(error));
			}

			if (committing) {
				// The server answered the COMMIT with an error: the transaction was rolled back (the ROLLBACK only makes
				// sure the connection is out of it). Without an answer (the connection was lost, or the session ended),
				// the commit may have happened.
				const rejected = isRejectedStatement(error) && !broken;
				if (rejected) {
					await rollback(client).catch(onError);
				}
				throw new EventStorePersistenceException(
					{ collection, outcome: rejected ? 'not-persisted' : 'unknown' },
					{ cause: error },
				);
			}

			if (!broken) {
				await rollback(client).catch(onError);
			}
			failure = error;
		} finally {
			client.removeListener('error', onError);
			client.release(broken);
		}

		// Classified once the connection is back in the pool: telling a conflict from a drift may take a connection of
		// its own, and appends that held every connection of the pool while they waited for one would never finish
		return this.classifyAppendError(failure, collection, pool);
	}

	/**
	 * Classifies a failure of an append before its `COMMIT`: nothing was stored.
	 */
	private async classifyAppendError(
		error: unknown,
		collection: IEventCollection,
		pool: IEventPool | undefined,
	): Promise<PersistOutcome> {
		const notPersisted = (cause: unknown) =>
			new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause });

		if (hasErrorCode(error, UNIQUE_VIOLATION)) {
			const constraint = (error as DatabaseError).constraint;
			const primaryKeys = await this.primaryKeysOf(collection).catch(() => undefined);
			if (constraint !== undefined && primaryKeys?.has(constraint)) {
				return { status: 'conflict', cause: error };
			}
			this.logger.error(
				`An append to ${collection} took a global position that is already stored (${constraint ?? 'unknown constraint'}): the position counter drifted. ensureCollection() heals the counter.`,
			);
			throw notPersisted(error);
		}
		if (hasErrorCode(error, UNDEFINED_TABLE)) {
			throw notPersisted(new EventCollectionNotFoundException({ collection, pool }, { cause: error }));
		}
		if (hasErrorCode(error, UNDEFINED_COLUMN)) {
			throw notPersisted(
				new EventStoreSchemaException({ collection, found: 'v1', remedy: MIGRATE_REMEDY }, { cause: error }),
			);
		}
		throw notPersisted(error);
	}

	/**
	 * The names of the primary key constraints of a table, cached: its own and, when it is partitioned, those of its
	 * partitions (a duplicate key names the constraint of the partition).
	 */
	private async primaryKeysOf(collection: IEventCollection): Promise<ReadonlySet<string>> {
		const cached = this.primaryKeys.get(collection);
		if (cached) {
			return cached;
		}
		const { rows } = await this.connection.query<{ name: string }>(
			`SELECT c.conname AS name
			FROM (SELECT to_regclass(format('%I.%I', current_schema(), $1::text)) AS oid) t
			JOIN pg_constraint c ON c.conrelid = t.oid OR c.conrelid IN (SELECT relid FROM pg_partition_tree(t.oid))
			WHERE c.contype = 'p'`,
			[collection],
		);
		const names = new Set(rows.map(({ name }) => name));
		if (names.size > 0) {
			this.primaryKeys.set(collection, names);
		}
		return names;
	}

	/**
	 * Creates the missing position index of a v2 table when that is cheap (an empty table), and otherwise logs how to.
	 */
	private async ensurePositionIndex(
		client: Pick<PoolClient, 'query'>,
		collection: IEventCollection,
		ddl: 'auto' | 'none',
	): Promise<void> {
		const statement = positionIndexStatement(collection);
		const {
			rows: [{ empty }],
		} = await client.query<{ empty: boolean }>(
			`SELECT NOT EXISTS (SELECT 1 FROM ${escapeIdentifier(collection)}) AS empty`,
		);
		if (ddl === 'auto' && empty) {
			await client.query(statement);
			return;
		}
		this.logger.warn(
			`Collection ${collection} has no unique index on global_position, which keeps the positions unique and readAll() fast. Create it with: ${statement.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY')};`,
		);
	}

	/**
	 * A read error in the terms of the store contract: an unknown pool, or a 3.x table.
	 */
	private readError(error: unknown, collection: IEventCollection, pool: IEventPool | undefined): unknown {
		if (hasErrorCode(error, UNDEFINED_TABLE)) {
			return new EventCollectionNotFoundException({ collection, pool }, { cause: error });
		}
		if (hasErrorCode(error, UNDEFINED_COLUMN)) {
			return new EventStoreSchemaException({ collection, found: 'v1', remedy: MIGRATE_REMEDY }, { cause: error });
		}
		return error;
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
 * The SQLSTATEs after which the session is gone: a connection exception (class 08), a shutdown or crash of the server
 * (57P01 to 57P05), or a session that was idle in a transaction for too long (25P03).
 */
const SESSION_ENDED = /^(08|57P0|25P03)/;

/**
 * Whether the server answered a statement with an error (it was rejected, and the connection still works), as opposed
 * to a lost connection or an ended session. `pg` reads the severity that `lc_messages` translates (`FEHLER`, `ERREUR`),
 * not the untranslated one: any severity but `FATAL` and `PANIC` counts as a rejection, unless the SQLSTATE says that
 * the session ended.
 */
const isRejectedStatement = (error: unknown): boolean =>
	error instanceof DatabaseError &&
	(error.severity === 'ERROR' ||
		(error.severity !== 'FATAL' && error.severity !== 'PANIC' && !SESSION_ENDED.test(error.code ?? '')));

const rollback = async (client: Pick<PoolClient, 'query'>): Promise<void> => {
	await client.query('ROLLBACK');
};

/**
 * The columns of the rows of an append, as `unnest` takes them. Serializes the payloads and headers, so that a value
 * JSON can't hold (a bigint, a cycle) fails before any I/O.
 */
const encodeRows = (stream: EventStream, envelopes: readonly EventEnvelope[]): unknown[][] => {
	const columns: unknown[][] = Array.from({ length: 11 }, () => []);
	for (const { event, payload, metadata } of envelopes) {
		const serialized = JSON.stringify(payload);
		if (serialized === undefined) {
			throw new TypeError(`The payload of the ${event} event is not JSON: ${String(payload)}`);
		}
		columns[0].push(stream.streamId);
		columns[1].push(metadata.version);
		columns[2].push(event);
		columns[3].push(serialized);
		columns[4].push(metadata.eventId.value);
		columns[5].push(metadata.aggregateId);
		columns[6].push(metadata.occurredOn.toISOString());
		columns[7].push(metadata.correlationId ?? null);
		columns[8].push(metadata.causationId ?? null);
		columns[9].push(metadata.headers === undefined ? null : JSON.stringify(metadata.headers));
		columns[10].push(metadata.eventVersion ?? null);
	}
	return columns;
};

const toEnvelope = ({
	event,
	payload,
	event_id,
	aggregate_id,
	version,
	occurred_on,
	correlation_id,
	causation_id,
	global_position,
	headers,
	event_version,
}: PostgresEnvelopeEntity): EventEnvelope => {
	const metadata: EventEnvelopeMetadata = {
		eventId: EventId.fromTrusted(event_id),
		aggregateId: aggregate_id,
		version,
		occurredOn: occurred_on,
		globalPosition: BigInt(global_position),
	};
	if (correlation_id !== null) metadata.correlationId = correlation_id;
	if (causation_id !== null) metadata.causationId = causation_id;
	if (headers !== null) metadata.headers = headers;
	if (event_version !== null) metadata.eventVersion = event_version;
	return EventEnvelope.from(event, payload, metadata);
};
