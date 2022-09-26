import { Db } from 'mongodb';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { EventMap } from '../../event-map';
import { EventFilter, EventStore, StreamEventFilter } from '../../event-store';
import { EventNotFoundException } from '../../exceptions';
import { EventEnvelopeMetadata, IEvent, IEventPayload, IEventPool } from '../../interfaces';
import { EventCollection, EventEnvelope, EventStream } from '../../models';

export interface MongoEventEntity {
	_id: string;
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
	metadata: EventEnvelopeMetadata;
}

export class MongoDBEventStore extends EventStore {
	constructor(readonly eventMap: EventMap, readonly database: Db) {
		super();
	}

	async setup(pool?: IEventPool): Promise<EventCollection> {
		const collection = EventCollection.get(pool);
		const eventCollection = await this.database.createCollection<MongoEventEntity>(collection);
		await eventCollection.createIndex({ streamId: 1, 'metadata.version': 1 }, { unique: true });
		return collection;
	}

	async *getEvents(filter?: EventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);
		let eventStream = filter?.eventStream;
		let fromVersion = eventStream && ((filter as StreamEventFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoEventEntity>(collection)
			.find(
				{
					...(eventStream && { streamId: eventStream.streamId }),
					...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					skip,
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
			'metadata.version': version,
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
	): Promise<void> {
		const collection = EventCollection.get(pool);

		let version = aggregateVersion - events.length + 1;
		const envelopes = events.reduce<EventEnvelope[]>((acc, event) => {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
			return [...acc, envelope];
		}, []);

		const entities = envelopes.map<MongoEventEntity>(
			({ event, payload, metadata }) => ({ _id: metadata.eventId, streamId, event, payload, metadata }),
		);

		await this.database.collection<MongoEventEntity>(collection).insertMany(entities);
	}

	async *getEnvelopes(filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);
		let eventStream = filter?.eventStream;
		let fromVersion = eventStream && ((filter as StreamEventFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoEventEntity>(collection)
			.find(
				{
					...(eventStream && { streamId: eventStream.streamId }),
					...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					skip,
					limit,
				},
			)
			.map(({ event, payload, metadata }) => EventEnvelope.from(event, payload, metadata));

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
			'metadata.version': version,
		});

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return EventEnvelope.from(entity.event, entity.payload, entity.metadata);
	}
}
