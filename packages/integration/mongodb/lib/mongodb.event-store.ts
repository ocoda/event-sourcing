import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventEnvelope,
	EventId,
	EventNotFoundException,
	EventStore,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	type EventStream,
	type IAllEventsFilter,
	type IEvent,
	type IEventCollection,
	type IEventCollectionFilter,
	type IEventFilter,
	type IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { type Collection, type Db, MongoClient } from 'mongodb';
import type { MongoDBEventEntity, MongoDBEventStoreConfig } from './interfaces/index.js';
import { batchCursor, isDuplicateKeyError } from './mongodb.utils.js';

export class MongoDBEventStore extends EventStore<MongoDBEventStoreConfig> {
	private client: MongoClient;
	private database: Db;
	/** Collections that are known to exist, so that appends don't have to look them up on every write. */
	private readonly knownCollections = new Set<string>();

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { url, useDefaultPool: _, ...params } = this.options;
		this.client = await new MongoClient(url, params).connect();
		this.database = this.client.db();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.knownCollections.clear();
		await this.client.close();
	}

	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);

		try {
			const [existingCollection] = await this.database.listCollections({ name: collection }).toArray();
			if (!existingCollection) {
				const eventCollection = await this.database.createCollection<MongoDBEventEntity>(collection);
				await eventCollection.createIndexes([
					{ key: { streamId: 1, version: 1 }, unique: true },
					{ key: { eventDate: 1, _id: 1 }, unique: true },
				]);
			}

			this.knownCollections.add(collection);

			return collection;
		} catch (error) {
			throw new EventStoreCollectionCreationException(collection, error);
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.listCollections({
				name: { $regex: /events/ },
			})
			.map(({ name }) => name as IEventCollection);

		yield* batchCursor(cursor, batch);
	}

	async *getEvents({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<Pick<MongoDBEventEntity, 'event' | 'payload'>>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
					projection: { _id: 0, event: 1, payload: 1 },
				},
			)
			.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload));

		yield* batchCursor(cursor, batch);
	}

	async getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		const collection = EventCollection.get(pool);
		const entity = await this.database.collection<Pick<MongoDBEventEntity, 'event' | 'payload'>>(collection).findOne(
			{
				streamId,
				version,
			},
			{ projection: { _id: 0, event: 1, payload: 1 } },
		);

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	async appendEvents(
		stream: EventStream,
		aggregateVersion: number,
		events: IEvent[] | EventEnvelope[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		try {
			const currentVersionResult = await this.database
				.collection<MongoDBEventEntity>(collection)
				.find({ streamId: stream.streamId })
				.sort({ version: -1 }) // Sort by version in descending order to get the latest
				.limit(1) // Only retrieve the most recent event
				.project({ version: 1 }) // Only select the version field
				.toArray();

			const currentVersion = currentVersionResult.length > 0 ? currentVersionResult[0].version : 0;

			// Step 2: Check if the aggregateVersion is valid
			if (aggregateVersion <= currentVersion) {
				throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion);
			}

			let version = aggregateVersion - events.length + 1;

			await this.assertCollectionExists(collection);

			const envelopes: EventEnvelope[] = [];
			const eventIdFactory = EventId.factory();
			for (const event of events) {
				if (event instanceof EventEnvelope) {
					envelopes.push(event);
					continue;
				}

				const name = this.eventMap.getName(event);
				const payload = this.eventMap.serializeEvent(event);
				const envelope = EventEnvelope.create(name, payload, {
					aggregateId: stream.aggregateId,
					eventId: eventIdFactory(),
					version: version++,
				});
				envelopes.push(envelope);
			}

			const entities = envelopes.map<MongoDBEventEntity>(({ event, payload, metadata }) => {
				const { eventId, ...rest } = metadata;
				return {
					_id: eventId.value,
					streamId: stream.streamId,
					event,
					payload,
					eventDate: eventId.yearMonth,
					...rest,
				};
			});

			const eventCollection = this.database.collection<MongoDBEventEntity>(collection);
			try {
				await eventCollection.insertMany(entities);
			} catch (error) {
				if (isDuplicateKeyError(error)) {
					// The insert is ordered and not atomic: take back the events that made it in before the conflict
					await this.discardInsertedEvents(eventCollection, entities, error);
				}
				throw error;
			}

			return envelopes;
		} catch (error) {
			if (error instanceof EventStoreVersionConflictException) {
				throw error;
			}

			// A concurrent writer stored the same (streamId, version) between our check and our insert.
			if (isDuplicateKeyError(error)) {
				const latestVersion = await this.getLatestVersion(collection, stream, aggregateVersion - events.length);
				throw new EventStoreVersionConflictException(stream, aggregateVersion, latestVersion, error);
			}

			throw new EventStorePersistenceException(collection, error);
		}
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		const entity = await this.database
			.collection<
				Pick<
					MongoDBEventEntity,
					'_id' | 'event' | 'payload' | 'aggregateId' | 'version' | 'occurredOn' | 'correlationId' | 'causationId'
				>
			>(collection)
			.findOne(
				{
					streamId,
					version,
				},
				{
					projection: {
						_id: 1,
						event: 1,
						payload: 1,
						eventId: 1,
						aggregateId: 1,
						version: 1,
						occurredOn: 1,
						correlationId: 1,
						causationId: 1,
					},
				},
			);

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return EventEnvelope.from(entity.event, entity.payload, {
			eventId: EventId.from(entity._id),
			aggregateId: entity.aggregateId,
			version: entity.version,
			occurredOn: entity.occurredOn,
			correlationId: entity.correlationId,
			causationId: entity.causationId,
		});
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<
				Pick<
					MongoDBEventEntity,
					'_id' | 'event' | 'payload' | 'aggregateId' | 'version' | 'occurredOn' | 'correlationId' | 'causationId'
				>
			>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
					projection: {
						_id: 1,
						event: 1,
						payload: 1,
						aggregateId: 1,
						version: 1,
						occurredOn: 1,
						correlationId: 1,
						causationId: 1,
					},
				},
			)
			.map(({ _id, event, payload, aggregateId, version, occurredOn, correlationId, causationId }) =>
				EventEnvelope.from(event, payload, {
					eventId: EventId.from(_id),
					aggregateId,
					version,
					occurredOn,
					correlationId,
					causationId,
				}),
			);

		yield* batchCursor(cursor, batch);
	}

	async *getAllEnvelopes(filter: IAllEventsFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);
		const yearMonths = this.getYearMonthRange(filter.since, filter.until);

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<
				Pick<
					MongoDBEventEntity,
					'_id' | 'event' | 'payload' | 'aggregateId' | 'version' | 'occurredOn' | 'correlationId' | 'causationId'
				>
			>(collection)
			.find(
				{ eventDate: { $in: yearMonths } },
				{
					sort: { eventDate: 1, _id: 1 },
					projection: {
						_id: 1,
						event: 1,
						payload: 1,
						aggregateId: 1,
						version: 1,
						occurredOn: 1,
						correlationId: 1,
						causationId: 1,
					},
				},
			)
			.map(({ _id, event, payload, aggregateId, version, occurredOn, correlationId, causationId }) =>
				EventEnvelope.from(event, payload, {
					eventId: EventId.from(_id),
					aggregateId,
					version,
					occurredOn,
					correlationId,
					causationId,
				}),
			);

		yield* batchCursor(cursor, batch);
	}

	/**
	 * Rejects appends to collections that were never created (unknown pools).
	 * Collections that are known to exist are not looked up again, the server is only asked on a cache miss.
	 */
	private async assertCollectionExists(collection: IEventCollection): Promise<void> {
		if (this.knownCollections.has(collection)) {
			return;
		}

		const collections = await this.database.listCollections({ name: collection }).toArray();

		if (collections.length === 0) {
			throw new Error(`Collection "${collection}" does not exist.`);
		}

		this.knownCollections.add(collection);
	}

	/**
	 * Removes the events of a failed ordered `insertMany` that were already stored.
	 * Only events that this very call inserted are removed. This is a best effort clean-up.
	 */
	private async discardInsertedEvents(
		eventCollection: Collection<MongoDBEventEntity>,
		entities: MongoDBEventEntity[],
		error: unknown,
	): Promise<void> {
		const { insertedCount } = error as { insertedCount?: number };
		if (!insertedCount) {
			return;
		}

		try {
			await eventCollection.deleteMany({ _id: { $in: entities.slice(0, insertedCount).map(({ _id }) => _id) } });
		} catch (cleanupError) {
			this.logger.error(`Failed to remove the events of a conflicting append: ${cleanupError.message}`);
		}
	}

	/**
	 * Best effort lookup of the latest version of a stream, used to report a conflict.
	 */
	private async getLatestVersion(
		collection: IEventCollection,
		{ streamId }: EventStream,
		fallback: number,
	): Promise<number> {
		try {
			const [latest] = await this.database
				.collection<MongoDBEventEntity>(collection)
				.find({ streamId })
				.sort({ version: -1 })
				.limit(1)
				.project({ version: 1 })
				.toArray();
			return latest?.version ?? fallback;
		} catch {
			return fallback;
		}
	}
}
