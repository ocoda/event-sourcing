import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	EventId,
	EventNotFoundException,
	EventStore,
	type EventStoreCapabilities,
	type EventStoreContext,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreSchemaException,
	type EventStream,
	type IEventCollection,
	type IEventCollectionFilter,
	type IEventFilter,
	type IEventPool,
	type IReadAllFilter,
	type MigrationReport,
	type PersistOutcome,
	type PersistTarget,
	StreamReadingDirection,
	isEventSourcingError,
	EventSourcingErrorCode,
	toBatchSize,
	toPosition,
} from '@ocoda/event-sourcing';
import { type ClientSession, type Collection, type Db, Long, MongoClient } from 'mongodb';
import type { MongoDBEventEntity, MongoDBEventStoreConfig, MongoDBMigrationOptions } from './interfaces/index.js';
import { migrateEventCollections } from './migration/events.js';
import {
	CATALOG_COLLECTION,
	type CatalogDocument,
	EVENT_INDEXES,
	EVENTS_VALIDATOR,
	SCHEMA_VERSION,
	VALIDATION_OPTIONS,
	catalogDdl,
	catalogExists,
	classifyValidator,
	eventCollectionDdl,
	findIndex,
	readCollectionShape,
} from './mongodb.schema.js';
import { type MongoDBTopology, capabilitiesOf, detectTopology, warnStandaloneOnce } from './mongodb.topology.js';
import {
	APPEND_LIMITS,
	backoff,
	batchCursor,
	duplicateKeyOf,
	hasErrorLabel,
	ifEmpty,
	isNamespaceExistsError,
} from './mongodb.utils.js';

/** The remedy for a 3.x collection. */
const MIGRATE_REMEDY =
	'Stop every 3.x instance, run MongoDBEventStore.migrate(config, { dryRun: true }) and review the report, then run migrate().';

/** The context of a store that only migrates: it appends nothing, so it serializes and publishes nothing. */
const MIGRATION_CONTEXT: EventStoreContext = Object.freeze({
	eventMap: undefined as never,
	publisher: { publishAll: async () => undefined },
});

type EventDocument = MongoDBEventEntity;

/**
 * The MongoDB event store (schema v2, ADR 0002 §4).
 *
 * Every pool is a collection with a validator and unique `{ streamId, version }` and `{ globalPosition }` indexes,
 * registered in the database's catalog (`event_sourcing_collections`), whose document holds the pool's position
 * counter. On a replica set, an append is one transaction that updates the counter first: appends are atomic, and a
 * reader never misses an event that commits late (`globalOrder: 'gap-safe'`). A standalone server has no
 * transactions: the store reserves the positions, inserts, and removes what it inserted when the insert fails
 * (`atomicAppend: false`, `globalOrder: 'best-effort'`).
 */
export class MongoDBEventStore extends EventStore<MongoDBEventStoreConfig> {
	/** The weakest guarantees until `connect()` detected the topology. */
	override readonly capabilities: EventStoreCapabilities = {
		atomicAppend: false,
		headers: true,
		globalOrder: 'best-effort',
	};

	private client?: MongoClient;
	private database!: Db;
	private topology: MongoDBTopology = 'standalone';
	/** Collections the catalog is known to register, so that empty reads don't have to look them up every time. */
	private readonly knownCollections = new Set<IEventCollection>();

	/**
	 * Migrates the 3.x event collections of a database to schema v2, without bootstrapping the application.
	 * Run it with `dryRun: true` first, and only while no 3.x instance runs. See `migrate()`.
	 */
	static async migrate(
		config: Omit<MongoDBEventStoreConfig, 'driver'>,
		options?: MongoDBMigrationOptions,
	): Promise<MigrationReport> {
		const store = new MongoDBEventStore(MIGRATION_CONTEXT, { ...config, driver: MongoDBEventStore });
		await store.connect();
		try {
			return await store.migrate(options);
		} finally {
			await store.disconnect();
		}
	}

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { url, ddl: _ddl, useDefaultPool: _useDefaultPool, driver: _driver, ...params } = this.options;
		const client = await new MongoClient(url, params).connect();
		try {
			this.topology = await detectTopology(client);
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
		this.client = client;
		this.database = client.db();
		Object.assign(this.capabilities, capabilitiesOf(this.topology));
		if (this.topology === 'standalone') {
			warnStandaloneOnce(this.logger);
		}
	}

	public async disconnect(): Promise<void> {
		const client = this.client;
		if (!client) {
			return;
		}
		this.logger.log('Stopping store');
		this.client = undefined;
		this.knownCollections.clear();
		await client.close();
	}

	/**
	 * Creates the collection of a pool with schema v2 and registers it, or registers an existing 4.0 collection and
	 * heals its counter. Never migrates: a 3.x collection throws an `EventStoreSchemaException`.
	 */
	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);
		const ddl = this.options.ddl ?? 'auto';

		try {
			const [shape, registered] = await Promise.all([
				readCollectionShape(this.database, collection),
				this.catalog().findOne({ _id: collection }),
			]);

			if (registered?.kind === 'events' && registered.schemaVersion === SCHEMA_VERSION) {
				if (!shape.exists) {
					this.assertDdl(ddl, collection, 'missing');
					await this.createCollection(collection);
				}
			} else if (!shape.exists) {
				if (ddl === 'none' && !(await catalogExists(this.database))) {
					throw this.schemaException(collection, 'missing', [catalogDdl(), ...eventCollectionDdl(collection)]);
				}
				this.assertDdl(ddl, collection, 'missing');
				await this.createCollection(collection);
			} else {
				const partial =
					classifyValidator(shape.validator) === 'v2' || findIndex(shape.indexes, { globalPosition: 1 }) !== undefined;
				if (!partial) {
					throw new EventStoreSchemaException({ collection, found: 'v1', remedy: MIGRATE_REMEDY });
				}
				// A collection with the 4.0 validator but no catalog document: a creation that stopped before the registration
				// (empty), or a migration that stopped before its commit point
				const empty = (await this.events(collection).findOne({}, { projection: { _id: 1 } })) === null;
				if (!empty) {
					throw new EventStoreSchemaException({ collection, found: 'v1-partial', remedy: MIGRATE_REMEDY });
				}
				if (ddl === 'auto') {
					await this.events(collection).createIndexes([...EVENT_INDEXES]);
				}
			}

			await this.register(collection);
			this.knownCollections.add(collection);
			return collection;
		} catch (error) {
			if (isEventSourcingError(error, EventSourcingErrorCode.EventStoreSchema)) {
				throw error;
			}
			throw new EventStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	/**
	 * Lists the event collections the catalog registers, in batches.
	 */
	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		const cursor = this.catalog()
			.find({ kind: 'events' }, { projection: { _id: 1 }, sort: { _id: 1 } })
			.map(({ _id }) => _id as IEventCollection);

		yield* batchCursor(cursor, batch);
	}

	public async getStreamVersion({ streamId }: EventStream, pool?: IEventPool): Promise<number> {
		const collection = EventCollection.get(pool);
		const [latest] = await this.events(collection)
			.find({ streamId }, { projection: { _id: 0, version: 1 }, sort: { version: -1 }, limit: 1 })
			.toArray();
		if (latest) {
			return Number(latest.version);
		}
		await this.assertKnownCollection(collection, pool);
		return 0;
	}

	public async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);
		const entity = await this.events(collection).findOne({ streamId, version });
		if (!entity) {
			await this.assertKnownCollection(collection, pool);
			throw new EventNotFoundException({ streamId, version, pool });
		}
		return toEnvelope(entity, collection);
	}

	public async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.events(collection)
			.find(
				{ streamId, ...(fromVersion && { version: { $gte: fromVersion } }) },
				{ sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 }, limit },
			)
			.map((entity) => toEnvelope(entity, collection));

		yield* ifEmpty(batchCursor(cursor, batch), () => this.assertKnownCollection(collection, filter?.pool));
	}

	/**
	 * Reads a pool in the order of the global positions: one query per batch, from the position after the last event of
	 * the previous batch, so no cursor stays open between batches. On a replica set and a `mongos` it reads with
	 * majority read concern, so a failover can't take back a position that was already read.
	 */
	public async *readAll(filter?: IReadAllFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);
		const batch = toBatchSize(filter?.batch);
		let fromPosition = filter?.fromPosition === undefined ? 0n : toPosition(filter.fromPosition);
		const readConcern = this.topology === 'standalone' ? undefined : ({ level: 'majority' } as const);

		for (let first = true; ; first = false) {
			const entities = await this.events(collection)
				.find(
					{ globalPosition: { $gte: Long.fromBigInt(fromPosition) } },
					{ sort: { globalPosition: 1 }, limit: batch, ...(readConcern && { readConcern }) },
				)
				.toArray();
			if (entities.length === 0) {
				if (first) {
					await this.assertKnownCollection(collection, filter?.pool);
				}
				return;
			}
			const envelopes = entities.map((entity) => toEnvelope(entity, collection));
			yield envelopes;
			if (entities.length < batch) {
				return;
			}
			fromPosition = (envelopes[envelopes.length - 1].metadata.globalPosition as bigint) + 1n;
		}
	}

	/**
	 * Migrates the 3.x event collections of the store's database to schema v2 (ADR 0002 §6): each collection is fenced
	 * against 3.x writers with the 4.0 validator, numbered on the server in 3.x's order (keeping every stream in version
	 * order), indexed and registered, which is its commit point; then its `eventDate` field is removed.
	 *
	 * - `dryRun: true` inspects and plans without writing, and reports the exact mongosh statements.
	 * - `pools` limits it to those pools; by default it migrates every collection named like an event collection.
	 * - A second run reports `skip`, and a run after an interruption resumes (`force` takes over the lease of an
	 *   interrupted run before it expires).
	 *
	 * Stop every 3.x instance first.
	 */
	public async migrate(options: MongoDBMigrationOptions = {}): Promise<MigrationReport> {
		return migrateEventCollections(
			{ client: this.connectedClient(), db: this.database, topology: this.topology, logger: this.logger },
			options,
		);
	}

	/**
	 * Stores the envelopes of an append. On a replica set (and a `mongos`), one transaction updates the pool's counter
	 * first, then inserts the events; on a standalone server, the positions are reserved first, and a failed insert is
	 * undone.
	 */
	protected async persistEvents(envelopes: readonly EventEnvelope[], target: PersistTarget): Promise<PersistOutcome> {
		return this.topology === 'standalone'
			? this.persistWithCompensation(envelopes, target)
			: this.persistInTransaction(envelopes, target);
	}

	private async persistInTransaction(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		const { collection } = target;
		const client = this.connectedClient();
		const deadline = Date.now() + APPEND_LIMITS.transactionBudgetMs;

		for (let attempt = 1; ; attempt++) {
			const session = client.startSession();
			let committing = false;
			try {
				session.startTransaction({
					readConcern: { level: 'snapshot' },
					writeConcern: { w: 'majority' },
					readPreference: 'primary',
				});
				const positions = await this.reservePositions(envelopes.length, target, session);
				await this.events(collection).insertMany(toDocuments(target, envelopes, positions), {
					session,
					ordered: true,
				});
				committing = true;
				await commitWithRetries(session);
				return { status: 'committed', positions };
			} catch (error) {
				if (session.inTransaction()) {
					await session.abortTransaction().catch(() => undefined);
				}
				if (isEventSourcingError(error, EventSourcingErrorCode.EventStorePersistence)) {
					throw error;
				}
				if (hasErrorLabel(error, 'TransientTransactionError')) {
					if (Date.now() < deadline) {
						await backoff(attempt);
						continue;
					}
					throw new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause: error });
				}
				if (committing) {
					// The commit was sent, and whether it happened is unknown
					throw new EventStorePersistenceException({ collection, outcome: 'unknown' }, { cause: error });
				}
				return this.classifyWriteError(error, envelopes, target);
			} finally {
				await session.endSession().catch(() => undefined);
			}
		}
	}

	private async persistWithCompensation(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		const { collection } = target;
		let positions: bigint[];
		try {
			positions = await this.reservePositions(envelopes.length, target);
		} catch (error) {
			if (isEventSourcingError(error, EventSourcingErrorCode.EventStorePersistence)) {
				throw error;
			}
			throw new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause: error });
		}

		const events = this.events(collection);
		try {
			await events.insertMany(toDocuments(target, envelopes, positions), { ordered: true });
			return { status: 'committed', positions };
		} catch (error) {
			// The insert is ordered but not atomic: remove what it stored. Its ids at the positions it reserved find exactly
			// its events, also when the error doesn't say how many were inserted (and when a drifted counter handed out
			// positions that other events hold).
			try {
				await events.deleteMany({
					_id: { $in: envelopes.map(({ metadata }) => metadata.eventId.value) },
					globalPosition: {
						$gte: Long.fromBigInt(positions[0]),
						$lte: Long.fromBigInt(positions[positions.length - 1]),
					},
				});
			} catch (cleanupError) {
				throw new EventStorePersistenceException(
					{ collection, outcome: 'unknown' },
					{
						cause: new AggregateError(
							[error, cleanupError],
							'The append failed, and the events it may have stored could not be removed',
						),
					},
				);
			}
			return this.classifyWriteError(error, envelopes, target);
		}
	}

	/**
	 * Increments the pool's counter by `count` and returns the positions it hands out. On a replica set this is the first
	 * write of the append's transaction, so appends to the pool commit in the order of their positions.
	 */
	private async reservePositions(count: number, target: PersistTarget, session?: ClientSession): Promise<bigint[]> {
		const counter = await this.catalog().findOneAndUpdate(
			{ _id: target.collection, kind: 'events' },
			{ $inc: { lastPosition: Long.fromNumber(count) } },
			{ session, returnDocument: 'after', projection: { _id: 0, lastPosition: 1 } },
		);
		if (!counter) {
			throw new EventStorePersistenceException(
				{ collection: target.collection, outcome: 'not-persisted' },
				{ cause: new EventCollectionNotFoundException({ collection: target.collection, pool: target.pool }) },
			);
		}
		const last = toPosition((counter as { lastPosition: Long | number | bigint }).lastPosition);
		return Array.from({ length: count }, (_, index) => last - BigInt(count - 1 - index));
	}

	/**
	 * The outcome of a write that failed before a commit (ADR 0001 D3): a duplicate on `{ streamId, version }` is a
	 * conflict, everything else stored nothing.
	 */
	private async classifyWriteError(
		error: unknown,
		envelopes: readonly EventEnvelope[],
		{ stream, collection, pool }: PersistTarget,
	): Promise<PersistOutcome> {
		switch (duplicateKeyOf(error)) {
			case 'stream-version':
				return { status: 'conflict', actualVersion: await this.latestVersion(stream, pool), cause: error };
			case 'id': {
				// The same append stored before (a retry after an 'unknown' outcome) is a conflict; an id that another stream
				// holds is not
				const head = await this.latestVersion(stream, pool);
				if (head !== undefined && head >= envelopes[0].metadata.version) {
					return { status: 'conflict', actualVersion: head, cause: error };
				}
				throw new EventStorePersistenceException(
					{ collection, outcome: 'not-persisted' },
					{ cause: new Error('An event id of the append is taken by another event', { cause: error }) },
				);
			}
			case 'position':
				this.logger.error(
					`The position counter of ${collection} is behind its events (position drift); ensureCollection() heals the counter`,
				);
				break;
		}
		throw new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause: error });
	}

	/** Best-effort read of the version of a stream, for a conflict. */
	private async latestVersion(stream: EventStream, pool?: IEventPool): Promise<number | undefined> {
		try {
			return await this.getStreamVersion(stream, pool);
		} catch {
			return undefined;
		}
	}

	/**
	 * Registers the collection of a pool in the catalog, or heals its counter: `lastPosition` becomes at least the
	 * highest position in the collection, and never decreases.
	 */
	private async register(collection: IEventCollection): Promise<void> {
		const [highest] = await this.events(collection)
			.find({}, { projection: { _id: 0, globalPosition: 1 }, sort: { globalPosition: -1 }, limit: 1 })
			.toArray();
		const lastPosition = highest?.globalPosition === undefined ? 0n : toPosition(highest.globalPosition);
		await this.catalog().updateOne(
			{ _id: collection },
			{
				$setOnInsert: { kind: 'events' },
				$set: { schemaVersion: SCHEMA_VERSION },
				$max: { lastPosition: Long.fromBigInt(lastPosition) },
			},
			{ upsert: true },
		);
	}

	private async createCollection(collection: IEventCollection): Promise<void> {
		try {
			await this.database.createCollection(collection, { validator: EVENTS_VALIDATOR, ...VALIDATION_OPTIONS });
		} catch (error) {
			if (!isNamespaceExistsError(error)) {
				throw error;
			}
		}
		await this.events(collection).createIndexes([...EVENT_INDEXES]);
	}

	private assertDdl(ddl: 'auto' | 'none', collection: IEventCollection, found: 'missing'): void {
		if (ddl === 'none') {
			throw this.schemaException(collection, found, eventCollectionDdl(collection));
		}
	}

	private schemaException(collection: IEventCollection, found: 'missing', statements: string[]) {
		return new EventStoreSchemaException({
			collection,
			found,
			remedy: `The store runs with ddl: 'none'; create it with: ${statements.join('; ')}`,
		});
	}

	/**
	 * Throws an `EventCollectionNotFoundException` unless the catalog registers the collection. Only called when a read
	 * found nothing; a registered collection is remembered.
	 */
	private async assertKnownCollection(collection: IEventCollection, pool?: IEventPool): Promise<void> {
		if (this.knownCollections.has(collection)) {
			return;
		}
		const registered = await this.catalog().findOne({ _id: collection, kind: 'events' }, { projection: { _id: 1 } });
		if (!registered) {
			throw new EventCollectionNotFoundException({ collection, pool });
		}
		this.knownCollections.add(collection);
	}

	private connectedClient(): MongoClient {
		if (!this.client) {
			throw new Error('The MongoDB event store is not connected: call connect() first');
		}
		return this.client;
	}

	private catalog(): Collection<CatalogDocument> {
		return this.database.collection<CatalogDocument>(CATALOG_COLLECTION);
	}

	private events(collection: IEventCollection): Collection<EventDocument> {
		return this.database.collection<EventDocument>(collection);
	}
}

/**
 * Commits, retrying a commit whose result is unknown (a network error or a failover while committing) up to
 * `APPEND_LIMITS.commitRetries` times; the server commits a transaction at most once.
 */
const commitWithRetries = async (session: ClientSession): Promise<void> => {
	for (let retry = 0; ; retry++) {
		try {
			await session.commitTransaction();
			return;
		} catch (error) {
			if (retry < APPEND_LIMITS.commitRetries && hasErrorLabel(error, 'UnknownTransactionCommitResult')) {
				continue;
			}
			throw error;
		}
	}
};

const toDocuments = (
	{ stream }: PersistTarget,
	envelopes: readonly EventEnvelope[],
	positions: readonly bigint[],
): EventDocument[] =>
	envelopes.map(({ event, payload, metadata }, index) => {
		const { eventId, aggregateId, version, occurredOn, correlationId, causationId, headers, eventVersion } = metadata;
		const entity: EventDocument = {
			_id: eventId.value,
			streamId: stream.streamId,
			event,
			payload,
			aggregateId,
			version,
			occurredOn,
			globalPosition: Long.fromBigInt(positions[index]),
		};
		// Absent fields are left out rather than stored as null
		if (correlationId !== undefined) entity.correlationId = correlationId;
		if (causationId !== undefined) entity.causationId = causationId;
		if (headers !== undefined) entity.headers = headers;
		if (eventVersion !== undefined) entity.eventVersion = eventVersion;
		return entity;
	});

const toEnvelope = (entity: EventDocument, collection: IEventCollection): EventEnvelope => {
	const { _id, event, payload, aggregateId, version, occurredOn, correlationId, causationId, headers, eventVersion } =
		entity;
	if (entity.globalPosition === undefined || entity.globalPosition === null) {
		// A document without a position is a 3.x document, in a collection that wasn't migrated
		throw new EventStoreSchemaException({ collection, found: 'v1', remedy: MIGRATE_REMEDY });
	}
	const metadata: EventEnvelope['metadata'] = {
		eventId: EventId.fromTrusted(_id),
		aggregateId,
		version: Number(version),
		occurredOn,
		globalPosition: toPosition(entity.globalPosition),
	};
	if (correlationId !== undefined && correlationId !== null) metadata.correlationId = correlationId;
	if (causationId !== undefined && causationId !== null) metadata.causationId = causationId;
	if (headers !== undefined && headers !== null) metadata.headers = headers;
	if (eventVersion !== undefined && eventVersion !== null) metadata.eventVersion = Number(eventVersion);
	return EventEnvelope.from(event, payload, metadata);
};
