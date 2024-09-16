import { Injectable, Logger } from '@nestjs/common';
import {
	DEFAULT_BATCH_SIZE,
	EventCollection,
	EventEnvelope,
	EventFilter,
	EventNotFoundException,
	EventStore,
	EventStream,
	IEvent,
	IEventCollection,
	IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { Db, MongoClient } from 'mongodb';
import { MongoDBEventStoreConfig, MongoEventEntity } from './interfaces';

@Injectable()
export class MongoDBEventStore extends EventStore<MongoDBEventStoreConfig> {
	private client: MongoClient;
	private database: Db;

	async start(): Promise<IEventCollection> {
		this.logger.log('Starting store');
		const { url, pool, ...params } = this.options;

		this.client = await new MongoClient(url, params).connect();
		this.database = this.client.db();

		const collection = EventCollection.get(pool);

		const [existingCollection] = await this.database.listCollections({ name: collection }).toArray();
		if (!existingCollection) {
			const eventCollection = await this.database.createCollection<MongoEventEntity>(collection);
			await eventCollection.createIndex({ streamId: 1, version: 1 }, { unique: true });
		}

		return collection;
	}

	async stop(): Promise<void> {
		this.logger.log('Stopping store');
		await this.client.close();
	}

	async *getEvents({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoEventEntity>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
				},
			)
			.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload));

		const entities = [];
		let hasNext: boolean;
		do {
			const entity = await cursor.next();
			hasNext = entity !== null;

			hasNext && entities.push(entity);

			if (entities.length > 0 && (entities.length === batch || !hasNext)) {
				yield entities;
				entities.length = 0;
			}
		} while (hasNext);
	}

	async getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		const collection = EventCollection.get(pool);
		const entity = await this.database.collection<MongoEventEntity>(collection).findOne({
			streamId,
			version,
		});

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	async appendEvents(
		{ streamId, aggregateId }: EventStream,
		aggregateVersion: number,
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		let version = aggregateVersion - events.length + 1;

		const envelopes: EventEnvelope[] = [];
		for (const event of events) {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
			envelopes.push(envelope);
		}

		const entities = envelopes.map<MongoEventEntity>(({ event, payload, metadata }) => ({
			_id: metadata.eventId,
			streamId,
			event,
			payload,
			...metadata,
		}));

		await this.database.collection<MongoEventEntity>(collection).insertMany(entities);

		return envelopes;
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoEventEntity>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
				},
			)
			.map(({ event, payload, eventId, aggregateId, version, occurredOn, correlationId, causationId }) =>
				EventEnvelope.from(event, payload, {
					eventId,
					aggregateId,
					version,
					occurredOn,
					correlationId,
					causationId,
				}),
			);

		const entities = [];
		let hasNext: boolean;
		do {
			const entity = await cursor.next();
			hasNext = entity !== null;

			hasNext && entities.push(entity);

			if (entities.length > 0 && (entities.length === batch || !hasNext)) {
				yield entities;
				entities.length = 0;
			}
		} while (hasNext);
	}

	async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const collection = EventCollection.get(pool);

		const entity = await this.database.collection<MongoEventEntity>(collection).findOne({
			streamId,
			version,
		});

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return EventEnvelope.from(entity.event, entity.payload, {
			eventId: entity.eventId,
			aggregateId: entity.aggregateId,
			version: entity.version,
			occurredOn: entity.occurredOn,
			correlationId: entity.correlationId,
			causationId: entity.causationId,
		});
	}
}