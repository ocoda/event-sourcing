import { EventEmitter2 } from '@nestjs/event-emitter';
import { Db, Document } from 'mongodb';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { EventMap } from '../../event-map';
import { EventFilter, EventStore } from '../../event-store';
import { EventNotFoundException } from '../../exceptions';
import { EventEnvelopeMetadata, IEvent, IEventPayload, IEventPool } from '../../interfaces';
import { EventCollection, EventEnvelope, EventStream } from '../../models';

export type MongoEventEntity = {
	_id: string;
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
} & Document &
	EventEnvelopeMetadata;

export class MongoDBEventStore extends EventStore {
	constructor(readonly eventMap: EventMap, readonly eventEmitter: EventEmitter2, readonly database: Db) {
		super();
	}

	async setup(pool?: IEventPool): Promise<EventCollection> {
		const collection = EventCollection.get(pool);
		const eventCollection = await this.database.createCollection<MongoEventEntity>(collection);
		await eventCollection.createIndex({ streamId: 1, version: 1 }, { unique: true });
		return collection;
	}

	async *getEvents({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<IEvent[]> {
		const collection = EventCollection.get(filter?.pool);

		let fromVersion = filter?.fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

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
	): Promise<void> {
		const collection = EventCollection.get(pool);

		let version = aggregateVersion - events.length + 1;
		const envelopes = events.reduce<EventEnvelope[]>((acc, event) => {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
			return [...acc, envelope];
		}, []);

		const entities = envelopes.map<MongoEventEntity>(({ event, payload, metadata }) => ({
			_id: metadata.eventId,
			streamId,
			event,
			payload,
			...metadata,
		}));

		await this.database.collection<MongoEventEntity>(collection).insertMany(entities);
		envelopes.forEach((envelope) => this.emit(envelope));
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		const collection = EventCollection.get(filter?.pool);

		let fromVersion = filter?.fromVersion;
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

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
				EventEnvelope.from(event, payload, { eventId, aggregateId, version, occurredOn, correlationId, causationId }),
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
