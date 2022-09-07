import { EventStream, EventEnvelope, Id } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';
import { Db, MongoClient } from 'mongodb';
import { EventEnvelopeMetadata, IEvent, IEventPayload } from '../../interfaces';
import { EventNotFoundException } from '../../exceptions';
import { EventMap } from '../../event-map';

export interface MongoEventEnvelopeEntity {
	_id: string;
	stream: string;
	eventName: string;
	payload: IEventPayload<IEvent>;
	metadata: EventEnvelopeMetadata;
}

export class MongoDBEventStore extends EventStore {
	private readonly database: Db;
	constructor(readonly eventMap: EventMap, readonly client: MongoClient) {
		super();
		this.database = client.db();
	}

	async getEvents(
		{ name, subject }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<IEvent[]> {
		return this.database
			.collection<MongoEventEnvelopeEntity>(subject)
			.find(
				{
					stream: name,
					...(fromVersion && { 'metadata.sequence': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.sequence': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
				},
			)
			.map(({ eventName, payload }) => this.eventMap.deserializeEvent(eventName, payload))
			.toArray();
	}

	async getEvent({ name, subject }: EventStream, version: number): Promise<IEvent> {
		const entity = await this.database.collection<MongoEventEnvelopeEntity>(subject).findOne({
			stream: name,
			'metadata.sequence': version,
		});

		if (!entity) {
			throw EventNotFoundException.withVersion(name, version);
		}

		return this.eventMap.deserializeEvent(entity.eventName, entity.payload);
	}

	async appendEvents(
		aggregateId: Id,
		aggregateVersion: number,
		{ name, subject }: EventStream,
		events: IEvent[],
	): Promise<void> {
		let sequence = aggregateVersion - events.length + 1;
		const envelopes = events.reduce<EventEnvelope[]>((acc, event) => {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.new(aggregateId, sequence++, name, payload);
			return [...acc, envelope];
		}, []);

		const entities = envelopes.map(({ eventId, ...rest }) => ({ stream: name, _id: eventId, ...rest }));

		await this.database.collection<MongoEventEnvelopeEntity>(subject).insertMany(entities);
	}

	async getEnvelopes(
		{ name, subject }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<EventEnvelope[]> {
		return this.database
			.collection<MongoEventEnvelopeEntity>(subject)
			.find(
				{
					stream: name,
					...(fromVersion && { 'metadata.sequence': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.sequence': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
				},
			)
			.map(({ _id, eventName, payload, metadata }) => {
				const event = this.eventMap.deserializeEvent(eventName, payload);
				return EventEnvelope.from(_id, eventName, event, metadata);
			})
			.toArray();
	}

	async getEnvelope({ name, subject }: EventStream, version: number): Promise<EventEnvelope> {
		const entity = await this.database.collection<MongoEventEnvelopeEntity>(subject).findOne({
			stream: name,
			'metadata.sequence': version,
		});

		if (!entity) {
			throw EventNotFoundException.withVersion(name, version);
		}

		const event = this.eventMap.deserializeEvent(entity.eventName, entity.payload);

		return EventEnvelope.from(entity._id, entity.eventName, event, entity.metadata);
	}
}
