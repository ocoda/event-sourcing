import { EventStream, EventEnvelope, Id } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';
import { Db } from 'mongodb';
import { EventEnvelopeMetadata, IEvent, IEventPayload } from '../../interfaces';
import { EventNotFoundException } from '../../exceptions';
import { EventMap } from '../../event-map';
import { ConsoleLogger, Type } from '@nestjs/common';
import { Client } from '@elastic/elasticsearch';

export interface EventEnvelopeEntity {
	_index: string;
	_id: string;
	_source: {
		stream: string;
		eventName: string;
		payload: IEventPayload<IEvent>;
		metadata: EventEnvelopeMetadata;
	};
}

export class ElasticsearchEventStore extends EventStore {
	constructor(readonly eventMap: EventMap, private readonly client: Client) {
		super();
	}

	async getEvents(
		{ name, subject }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<IEvent[]> {
		const query = {
			bool: {
				must: [
					{ match: { stream: name } },
					...(fromVersion ? [{ range: { 'metadata.sequence': { gte: fromVersion } } }] : []),
				],
			},
		};

		const sort =
			direction === StreamReadingDirection.FORWARD ? { 'metadata.sequence': 'asc' } : { 'metadata.sequence': 'desc' };

		const { body } = await this.client.search({
			index: subject,
			body: { query, sort },
		});

		return body.hits.hits.map(({ _source: { eventName, payload } }: EventEnvelopeEntity) => {
			return this.eventMap.deserializeEvent(eventName, payload);
		});
	}

	async getEvent({ name, subject }: EventStream, version: number): Promise<IEvent> {
		const query = {
			bool: {
				must: [{ match: { stream: name } }, { match: { 'metadata.sequence': version } }],
			},
		};

		const { body } = await this.client.search({
			index: subject,
			body: { query },
			error_trace: false,
		});

		const entity: EventEnvelopeEntity = body.hits.hits[0];

		if (!entity) {
			throw EventNotFoundException.withVersion(name, version);
		}

		return this.eventMap.deserializeEvent(entity._source.eventName, entity._source.payload);
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

		const body = envelopes.flatMap(
			({ eventId, ...rest }) => [{ index: { _index: subject, _id: eventId } }, { stream: name, ...rest }],
		);

		await this.client.bulk({ index: subject, body, refresh: 'wait_for' });
	}

	async getEnvelopes(
		{ name, subject }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<EventEnvelope[]> {
		const query = {
			bool: {
				must: [
					{ match: { stream: name } },
					...(fromVersion ? [{ range: { 'metadata.sequence': { gte: fromVersion } } }] : []),
				],
			},
		};

		const sort =
			direction === StreamReadingDirection.FORWARD ? { 'metadata.sequence': 'asc' } : { 'metadata.sequence': 'desc' };

		const { body } = await this.client.search({
			index: subject,
			body: { query, sort },
		});

		return body.hits.hits.map(
			({ _id, _source: { eventName, payload, metadata } }: EventEnvelopeEntity) =>
				EventEnvelope.from(_id, eventName, this.eventMap.deserializeEvent(eventName, payload), metadata),
		);
	}

	async getEnvelope({ name, subject }: EventStream, version: number): Promise<EventEnvelope> {
		const query = {
			bool: {
				must: [{ match: { stream: name } }, { match: { 'metadata.sequence': version } }],
			},
		};

		const { body } = await this.client.search({
			index: subject,
			body: { query },
			error_trace: false,
		});

		const entity: EventEnvelopeEntity = body.hits.hits[0];

		if (!entity) {
			throw EventNotFoundException.withVersion(name, version);
		}

		return EventEnvelope.from(
			entity._id,
			entity._source.eventName,
			this.eventMap.deserializeEvent(entity._source.eventName, entity._source.payload),
			entity._source.metadata,
		);
	}
}
