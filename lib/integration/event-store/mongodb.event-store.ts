import { EventStream, EventEnvelope } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';
import { Db } from 'mongodb';
import { EventEnvelopeMetadata, IEvent, IEventPayload, IEventPool } from '../../interfaces';
import { EventNotFoundException } from '../../exceptions';
import { EventMap } from '../../event-map';

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

	async setup(pool?: IEventPool): Promise<void> {
		const eventCollection = await this.database.createCollection<MongoEventEntity>(pool ? `${pool}-events` : 'events');
		await eventCollection.createIndex({ streamId: 1, 'metadata.version': 1 }, { unique: true });
	}

	getEvents(
		{ collection, streamId }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<IEvent[]> {
		return this.database
			.collection<MongoEventEntity>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
				},
			)
			.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload))
			.toArray();
	}

	async getEvent({ collection, streamId }: EventStream, version: number): Promise<IEvent> {
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
		{ collection, streamId, aggregateId }: EventStream,
		aggregateVersion: number,
		events: IEvent[],
	): Promise<void> {
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

	getEnvelopes(
		{ collection, streamId }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<EventEnvelope[]> {
		return this.database
			.collection<MongoEventEntity>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
				},
			)
			.map(({ event, payload, metadata }) => {
				return EventEnvelope.from(event, payload, metadata);
			})
			.toArray();
	}

	async getEnvelope({ collection, streamId }: EventStream, version: number): Promise<EventEnvelope> {
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
