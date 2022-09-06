import { EventStream, EventEnvelope } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';
import { Db } from 'mongodb';
import { EventEnvelopeMetadata } from '../../interfaces';

export interface EventEnvelopeEntity {
	_id: string;
	stream: string;
	eventName: string;
	payload: Record<string, any>;
	metadata: EventEnvelopeMetadata;
}

export class MongoDBEventStore extends EventStore {
	constructor(protected readonly database: Db) {
		super();
	}

	async getEvents(
		{ name, subject }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<EventEnvelope[]> {
		const entities = await this.database.collection<EventEnvelopeEntity>(subject).find(
			{
				stream: name,
				...(fromVersion && { 'metadata.sequence': { $gte: fromVersion } }),
			},
			{
				...(direction === StreamReadingDirection.BACKWARD && { sort: { 'metadata.sequence': -1 } }),
			},
		);

		return entities.map(
			({ _id, eventName, payload, metadata }) => EventEnvelope.from(_id, eventName, payload, metadata),
		).toArray();
	}

	async getEvent({ name, subject }: EventStream, version: number): Promise<EventEnvelope> {
		const { _id, eventName, payload, metadata } = await this.database.collection<EventEnvelopeEntity>(subject).findOne({
			stream: name,
			'metadata.sequence': version,
		});
		return EventEnvelope.from(_id, eventName, payload, metadata);
	}

	async appendEvents({ name, subject }: EventStream, envelopes: EventEnvelope[]): Promise<void> {
		await this.database.collection<EventEnvelopeEntity>(subject).insertMany(
			envelopes.map(({ eventId, ...rest }) => ({ stream: name, _id: eventId, ...rest })),
		);
	}
}
