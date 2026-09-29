import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	EventId,
	EventNotFoundException,
	EventSourcingError,
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
	toBatchSize,
	toPosition,
} from '@ocoda/event-sourcing';
import { type Pool, type PoolConnection, createPool } from 'mariadb';
import type { MariaDBEventEntity, MariaDBEventStoreConfig } from './interfaces/index.js';
import {
	CATALOG_TABLE,
	assertTableName,
	catalogDdl,
	catalogExists,
	escapeId,
	eventSchemaRemedy,
	eventTableDdl,
	inspectEventTable,
	registerEventTable,
} from './mariadb.schema.js';
import {
	MariaDBErrorNumber,
	duplicateKeyOf,
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

/** The columns of an envelope, with the global position and the time as text. */
const ENVELOPE_COLUMNS = `event, payload, event_id, aggregate_id, version, CAST(occurred_on AS CHAR) AS occurred_on,
	correlation_id, causation_id, CAST(global_position AS CHAR) AS global_position, headers, event_version`;

const INSERT_COLUMNS =
	'stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id, global_position, headers, event_version';

const MIGRATE_REMEDY = 'Run MariaDBEventStore.migrate(config, { dryRun: true }), review the report, then migrate().';

/**
 * An event store on MariaDB (InnoDB), with schema v2 (ADR 0002 §3).
 *
 * - Every pool has a table, `events` or `<pool>-events`, registered in the `event_sourcing_collections` catalog, whose
 *   row counts the pool's global positions.
 * - An append takes its positions from that counter, as the first write of its transaction, so appends to a pool
 *   commit in the order of their positions, and a reader never skips one (`globalOrder: 'gap-safe'`).
 * - `ensureCollection` creates the tables (`ddl: 'auto'`) or checks them (`ddl: 'none'`), and refuses 3.x tables:
 *   migrate them with `MariaDBEventStore.migrate()`.
 */
export class MariaDBEventStore extends EventStore<MariaDBEventStoreConfig> {
	/**
	 * Final once `connect()` resolved: a Galera cluster (`wsrep_on`) orders the positions per node only, so it gets
	 * `'best-effort'`.
	 */
	override readonly capabilities: EventStoreCapabilities = {
		atomicAppend: true,
		headers: true,
		globalOrder: 'gap-safe',
	};

	private pool: Pool | undefined;

	/**
	 * Migrates the event tables of a 3.x store to schema v2, without a NestJS application: inspects every table (or the
	 * tables of `options.pools`), plans, and, unless `dryRun`, migrates them one by one. Stop every 3.x instance first.
	 */
	static migrate(
		config: Omit<MariaDBEventStoreConfig, 'driver'>,
		options?: MigrationOptions,
	): Promise<MigrationReport> {
		return runMigration(config, 'events', options);
	}

	/**
	 * Migrates the event tables of this store's database to schema v2, on a connection of its own; see the static
	 * `MariaDBEventStore.migrate()`.
	 */
	migrate(options?: MigrationOptions): Promise<MigrationReport> {
		return runMigration(this.options, 'events', options);
	}

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { driver: _driver, useDefaultPool: _useDefaultPool, ddl: _ddl, ...poolConfig } = this.options ?? {};
		const pool = createPool(poolConfig);

		// Also makes a bad connection fail the bootstrap
		let wsrep: unknown;
		try {
			[{ wsrep }] = await pool.query<{ wsrep: unknown }[]>('SELECT @@wsrep_on AS wsrep');
		} catch (error) {
			if (errorNumberOf(error) !== MariaDBErrorNumber.UnknownSystemVariable) {
				await pool.end().catch(() => undefined);
				throw error;
			}
		}
		if (wsrep === 1 || wsrep === 1n || String(wsrep).toUpperCase() === 'ON') {
			Object.assign(this.capabilities, { globalOrder: 'best-effort' });
			this.logger.warn(
				"Galera (wsrep_on) orders the global positions per node only: globalOrder is 'best-effort' on this cluster",
			);
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
	 * (`ddl: 'none'`). Registering heals the pool's position counter: it becomes at least the highest position stored.
	 * @throws EventStoreSchemaException when the table has the 3.x schema, or, with `ddl: 'none'`, doesn't exist
	 */
	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);
		const db = this.connected();

		try {
			assertTableName(collection);
			if (this.options?.ddl === 'none') {
				if (!(await catalogExists(db))) {
					throw new EventStoreSchemaException({
						collection,
						found: 'missing',
						remedy: `The catalog ${CATALOG_TABLE} doesn't exist. ${eventSchemaRemedy(collection)}`,
					});
				}
			} else {
				await db.query(catalogDdl());
			}

			const { state } = await inspectEventTable(db, collection);
			switch (state) {
				case 'absent':
					if (this.options?.ddl === 'none') {
						throw new EventStoreSchemaException({
							collection,
							found: 'missing',
							remedy: eventSchemaRemedy(collection),
						});
					}
					await db.query(eventTableDdl(collection));
					break;
				case 'v1':
				case 'v1-partial':
					throw new EventStoreSchemaException({ collection, found: state, remedy: MIGRATE_REMEDY });
			}
			await registerEventTable(db, collection);

			return collection;
		} catch (error) {
			if (error instanceof EventSourcingError) {
				throw error;
			}
			throw new EventStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	/**
	 * Lists the event collections of the catalog, in binary order. 3.x tables are not listed: they aren't registered.
	 */
	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		let after = '';
		while (true) {
			let rows: { name: IEventCollection }[];
			try {
				rows = await this.connected().query<{ name: IEventCollection }[]>(
					`SELECT name FROM ${escapeId(CATALOG_TABLE)} WHERE kind = 'events' AND schema_version = 2 AND name > ? ORDER BY name LIMIT ?`,
					[after, batch],
				);
			} catch (error) {
				// No catalog, no collections
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

	public async getStreamVersion({ streamId }: EventStream, pool?: IEventPool): Promise<number> {
		const collection = EventCollection.get(pool);
		try {
			const [{ version }] = await this.connected().query<{ version: number | bigint | string }[]>(
				`SELECT COALESCE(MAX(version), 0) AS version FROM ${escapeId(collection)} WHERE stream_id = ?`,
				[streamId],
			);
			return Number(version);
		} catch (error) {
			throw readError(error, collection, pool);
		}
	}

	public async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		let entity: MariaDBEventEntity | undefined;
		try {
			[entity] = await this.connected().query<MariaDBEventEntity[]>(
				`SELECT ${ENVELOPE_COLUMNS} FROM ${escapeId(collection)} WHERE stream_id = ? AND version = ?`,
				[streamId, version],
			);
		} catch (error) {
			throw readError(error, collection, pool);
		}

		if (!entity) {
			throw new EventNotFoundException({ streamId, version, pool });
		}
		return toEnvelope(entity);
	}

	public async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const pool = filter?.pool;
		const collection = EventCollection.get(pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];
		const envelopes = async function* (rows: AsyncIterable<MariaDBEventEntity>) {
			for await (const row of rows) {
				yield toEnvelope(row);
			}
		};

		try {
			const query = `
				SELECT ${ENVELOPE_COLUMNS}
				FROM ${escapeId(collection)}
				WHERE stream_id = ?
				${fromVersion ? 'AND version >= ?' : ''}
				ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
				LIMIT ?
			`;
			yield* inBatches(envelopes(streamRows<MariaDBEventEntity>(this.connected(), query, params)), batch);
		} catch (error) {
			throw readError(error, collection, pool);
		}
	}

	/**
	 * Reads the envelopes of a pool in the order of their global positions, one statement per batch.
	 *
	 * InnoDB builds a read view from a walk over the active transactions that isn't atomic, so a batch can, rarely, show
	 * a position without an earlier one that committed just before it. A batch is therefore delivered only as far as its
	 * positions are contiguous from where the read is. At a gap, the reader reads the counter with a shared lock, which
	 * waits for the append that holds it: every position up to it is committed and visible then, and a gap below it is
	 * permanent (a deleted event, or a pool that was dropped and created again).
	 */
	public async *readAll(filter?: IReadAllFilter): AsyncGenerator<EventEnvelope[]> {
		const batch = toBatchSize(filter?.batch);
		const pool = filter?.pool;
		const collection = EventCollection.get(pool);
		let from = filter?.fromPosition === undefined ? 0n : toPosition(filter.fromPosition);

		while (true) {
			const rows = await this.readPositions(collection, pool, from, batch);
			if (rows.length === 0) {
				return;
			}

			const contiguous = contiguousPrefix(rows, from);
			if (contiguous.length > 0) {
				yield contiguous.map(toEnvelope);
				from = BigInt(contiguous[contiguous.length - 1].global_position) + 1n;
				if (contiguous.length === rows.length && rows.length < batch) {
					return;
				}
				continue;
			}

			// The first position isn't the next one: wait for the committed high-water mark, then everything up to it is
			// visible, and what is missing below it is gone for good
			const highWaterMark = await this.readHighWaterMark(collection, pool);
			let settled = await this.readPositions(collection, pool, from, batch, highWaterMark);
			if (settled.length === 0) {
				// Stored positions above the counter: drift, which ensureCollection() heals. The rows are committed.
				this.logger.warn(
					`${collection} holds global positions above its counter (${highWaterMark}); ensureCollection() heals it`,
				);
				settled = rows;
			}
			yield settled.map(toEnvelope);
			from = BigInt(settled[settled.length - 1].global_position) + 1n;
		}
	}

	/**
	 * Stores the envelopes of an append in one transaction, whose first write takes their positions from the pool's
	 * counter in the catalog. The counter's row lock serializes the appends to a pool until they commit.
	 */
	protected async persistEvents(
		envelopes: readonly EventEnvelope[],
		{ stream, collection, pool }: PersistTarget,
	): Promise<PersistOutcome> {
		// Encoded before any I/O: a payload that JSON can't hold (a bigint, a cycle) fails without touching the database
		let rows: unknown[][];
		let table: string;
		try {
			table = escapeId(collection);
			rows = envelopes.map(({ event, payload, metadata }) => [
				stream.streamId,
				metadata.version,
				event,
				JSON.stringify(payload),
				metadata.eventId.value,
				metadata.aggregateId,
				toDateTime(metadata.occurredOn),
				metadata.correlationId ?? null,
				metadata.causationId ?? null,
				null, // the position, once the counter handed it out
				metadata.headers === undefined ? null : JSON.stringify(metadata.headers),
				metadata.eventVersion ?? null,
			]);
		} catch (error) {
			throw new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause: error });
		}

		let connection: PoolConnection;
		try {
			connection = await this.connected().getConnection();
		} catch (error) {
			throw new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause: error });
		}

		let committing = false;
		let broken = false;
		try {
			// READ COMMITTED, explicitly: with innodb_snapshot_isolation (the default from MariaDB 11.6.2), a REPEATABLE READ
			// transaction fails with 1020 once a row it read changed. The three statements are pipelined.
			const [, , counter] = await Promise.all([
				connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'),
				connection.query('START TRANSACTION'),
				connection.query<{ affectedRows: number; insertId: unknown }>(
					`UPDATE ${escapeId(CATALOG_TABLE)} SET last_position = LAST_INSERT_ID(last_position + ?) WHERE name = ? AND kind = 'events'`,
					[envelopes.length, collection],
				),
			]);
			if (counter.affectedRows === 0) {
				throw new EventStorePersistenceException(
					{ collection, outcome: 'not-persisted' },
					{ cause: new EventCollectionNotFoundException({ collection, pool }) },
				);
			}

			const last = await lastInsertIdOf(connection, counter.insertId);
			const first = last - BigInt(envelopes.length) + 1n;
			const positions = envelopes.map((_, index) => first + BigInt(index));
			for (const [index, row] of rows.entries()) {
				row[9] = positions[index];
			}

			await connection.query(
				`INSERT INTO ${table} (${INSERT_COLUMNS}) VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
				rows.flat(),
			);

			committing = true;
			await connection.commit();
			return { status: 'committed', positions };
		} catch (error) {
			broken = isFatalConnectionError(error);
			if (committing) {
				// The commit was sent: it may have happened
				throw new EventStorePersistenceException({ collection, outcome: 'unknown' }, { cause: error });
			}
			// Also after a lock wait timeout, which doesn't roll the transaction back (innodb_rollback_on_timeout is off)
			await connection.rollback().catch(() => {
				broken = true;
			});
			return this.classifyFailure(error, collection, pool);
		} finally {
			if (broken) {
				await connection.destroy();
			} else {
				await connection.release();
			}
		}
	}

	/**
	 * What a failed append before its commit means: another append took the (stream, version) key (a conflict), or
	 * nothing was stored.
	 */
	private classifyFailure(error: unknown, collection: IEventCollection, pool?: IEventPool): PersistOutcome {
		if (error instanceof EventStorePersistenceException) {
			throw error;
		}
		if (isDuplicateEntryError(error)) {
			const key = duplicateKeyOf(error);
			if (key === 'PRIMARY') {
				return { status: 'conflict', cause: error };
			}
			this.logger.error(
				`Appending to ${collection} failed on the unique key ${key ?? 'unknown'}: the position counter is behind the stored positions. ensureCollection() heals it.`,
			);
		}
		const cause =
			errorNumberOf(error) === MariaDBErrorNumber.NoSuchTable
				? new EventCollectionNotFoundException({ collection, pool }, { cause: error })
				: error;
		throw new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause });
	}

	private async readPositions(
		collection: IEventCollection,
		pool: IEventPool | undefined,
		from: bigint,
		batch: number,
		upTo?: bigint,
	): Promise<MariaDBEventEntity[]> {
		try {
			// Qualified: the unqualified name in ORDER BY would be the text alias of the select list, in string order
			return await this.connected().query<MariaDBEventEntity[]>(
				`SELECT ${ENVELOPE_COLUMNS} FROM ${escapeId(collection)} e
				 WHERE e.global_position >= ?${upTo === undefined ? '' : ' AND e.global_position <= ?'}
				 ORDER BY e.global_position LIMIT ?`,
				upTo === undefined ? [from, batch] : [from, upTo, batch],
			);
		} catch (error) {
			throw readError(error, collection, pool);
		}
	}

	/**
	 * The last position of the pool's counter, read with a shared lock: it waits until the append that holds the counter
	 * committed or rolled back, and every transaction that took a position up to it has left the set of active
	 * transactions before it returns (InnoDB deregisters a committing transaction before it releases its locks).
	 */
	private async readHighWaterMark(collection: IEventCollection, pool?: IEventPool): Promise<bigint> {
		let rows: { last_position: string }[];
		try {
			rows = await this.connected().query<{ last_position: string }[]>(
				`SELECT CAST(last_position AS CHAR) AS last_position FROM ${escapeId(CATALOG_TABLE)} WHERE name = ? AND kind = 'events' LOCK IN SHARE MODE`,
				[collection],
			);
		} catch (error) {
			throw readError(error, collection, pool);
		}
		if (rows.length === 0) {
			throw new EventCollectionNotFoundException({ collection, pool });
		}
		return toPosition(rows[0].last_position);
	}

	private connected(): Pool {
		if (!this.pool) {
			throw new Error(`${this.constructor.name} is not connected: call connect() first`);
		}
		return this.pool;
	}
}

/** The rows at the start of `rows` whose positions run on from `from` without a gap. */
const contiguousPrefix = (rows: readonly MariaDBEventEntity[], from: bigint): MariaDBEventEntity[] => {
	let expected = from;
	let length = 0;
	for (const row of rows) {
		const position = BigInt(row.global_position);
		// Positions start at 1: reading from 0 expects 1
		if (position !== expected && !(expected === 0n && position === 1n)) {
			break;
		}
		expected = position + 1n;
		length++;
	}
	return rows.slice(0, length);
};

/**
 * The counter after the append: the connector's `insertId` (the value of `LAST_INSERT_ID(expr)`), or, when the
 * connector returns it as an unsafe number (`insertIdAsNumber`, `bigIntAsNumber`), `LAST_INSERT_ID()` read as text.
 */
const lastInsertIdOf = async (connection: PoolConnection, insertId: unknown): Promise<bigint> => {
	if (typeof insertId === 'bigint') {
		return insertId;
	}
	if (typeof insertId === 'number' && Number.isSafeInteger(insertId)) {
		return BigInt(insertId);
	}
	const [{ id }] = await connection.query<{ id: string }[]>('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
	return toPosition(id);
};

/**
 * The error a read throws: `EventCollectionNotFoundException` for a missing table, `EventStoreSchemaException` for a
 * 3.x table (a missing column), otherwise the error itself.
 */
const readError = (error: unknown, collection: IEventCollection, pool?: IEventPool): unknown => {
	switch (errorNumberOf(error)) {
		case MariaDBErrorNumber.NoSuchTable:
			return new EventCollectionNotFoundException({ collection, pool }, { cause: error });
		case MariaDBErrorNumber.BadField:
			return new EventStoreSchemaException({ collection, found: 'v1', remedy: MIGRATE_REMEDY }, { cause: error });
		default:
			return error;
	}
};

const toEnvelope = (row: MariaDBEventEntity): EventEnvelope =>
	EventEnvelope.from(row.event, fromJson(row.payload), {
		eventId: EventId.fromTrusted(row.event_id),
		aggregateId: row.aggregate_id,
		version: Number(row.version),
		occurredOn: fromDateTime(row.occurred_on),
		...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
		...(row.causation_id === null ? {} : { causationId: row.causation_id }),
		...(row.headers === null ? {} : { headers: fromJson(row.headers) }),
		...(row.event_version === null ? {} : { eventVersion: Number(row.event_version) }),
		globalPosition: toPosition(row.global_position),
	});
