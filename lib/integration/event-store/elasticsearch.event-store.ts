import { Client } from '@elastic/elasticsearch';
import { StreamReadingDirection } from '../../constants';
import { EventMap } from '../../event-map';
import { EventFilter, EventStore } from '../../event-store';
import { EventNotFoundException } from '../../exceptions';
import { EventEnvelopeMetadata, IEvent, IEventPayload, IEventPool } from '../../interfaces';
import { EventEnvelope, EventStream } from '../../models';

export interface ElasticsearchEventEntity {
	_index: string;
	_id: string;
	_source: {
		streamId: string;
		event: string;
		payload: IEventPayload<IEvent>;
		metadata: EventEnvelopeMetadata;
	};
}

export class ElasticsearchEventStore extends EventStore {
	constructor(readonly eventMap: EventMap, private readonly client: Client) {
		super();
	}

	async setup(pool?: IEventPool): Promise<void> {
		await this.client.indices.create({
			index: pool ? `${pool}-events` : 'events',
			body: {
				aliases: { all: {} },
				mappings: {
					properties: {
						streamId: { type: 'text', index: true },
						event: { type: 'keyword' },
						payload: { type: 'object' },
						metadata: {
							type: 'object',
							properties: {
								eventId: { type: 'keyword' },
								aggregateId: { type: 'keyword' },
								version: { type: 'integer', index: true },
								occurredOn: { type: 'date' },
								correlationId: { type: 'keyword' },
								causationId: { type: 'keyword' },
							},
						},
					},
				},
			},
		});
	}

	async *getEvents(filter?: EventFilter): AsyncGenerator<IEvent[]> {
		let size = filter?.limit || 10;
		let query: Record<string, any> = { bool: { must: [] } };

		filter?.eventStream && query.bool.must.push({ match: { streamId: filter.eventStream.streamId } });
		filter?.fromVersion && query.bool.must.push({ range: { 'metadata.version': { gte: filter.fromVersion } } });

		if (query.bool.must.length === 0) {
			query = { match_all: {} };
		}

		const sort =
			filter?.direction === StreamReadingDirection.BACKWARD
				? { 'metadata.version': 'desc' }
				: { 'metadata.version': 'asc' };

		const scrollSearch = this.client.helpers.scrollSearch<ElasticsearchEventEntity[]>({
			index: filter?.eventStream?.collection || 'all',
			body: { query, sort },
			size,
		});

		for await (const { body } of scrollSearch) {
			yield body.hits.hits.map(({ _source: { event, payload } }) => this.eventMap.deserializeEvent(event, payload));
		}
	}

	async getEvent({ collection, streamId }: EventStream, version: number): Promise<IEvent> {
		const query = {
			bool: {
				must: [{ match: { streamId } }, { match: { 'metadata.version': version } }],
			},
		};

		const { body } = await this.client.search({
			index: collection,
			body: { query },
		});

		const entity: ElasticsearchEventEntity = body.hits.hits[0];

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.eventMap.deserializeEvent(entity._source.event, entity._source.payload);
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

		const body = envelopes.flatMap(
			({ event, metadata, payload }) => [
				{ index: { _index: collection, _id: metadata.eventId } },
				{ streamId, event, metadata, payload },
			],
		);

		await this.client.bulk({ index: collection, body, refresh: 'wait_for' });
	}

	async *getEnvelopes(filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		let size = filter?.limit || 10;
		let query: Record<string, any> = { bool: { must: [] } };

		filter?.eventStream && query.bool.must.push({ match: { streamId: filter.eventStream.streamId } });
		filter?.fromVersion && query.bool.must.push({ range: { 'metadata.version': { gte: filter.fromVersion } } });

		if (query.bool.must.length === 0) {
			query = { match_all: {} };
		}

		const sort =
			filter?.direction === StreamReadingDirection.BACKWARD
				? { 'metadata.version': 'desc' }
				: { 'metadata.version': 'asc' };

		const scrollSearch = this.client.helpers.scrollSearch<ElasticsearchEventEntity[]>({
			index: filter?.eventStream?.collection || 'all',
			body: { query, sort },
			size,
		});

		for await (const { body } of scrollSearch) {
			yield body.hits.hits.map(
				({ _source: { event, payload, metadata } }) =>
					EventEnvelope.from(event, payload, { ...metadata, occurredOn: new Date(metadata.occurredOn) }),
			);
		}
	}

	async getEnvelope({ collection, streamId }: EventStream, version: number): Promise<EventEnvelope> {
		const query = {
			bool: {
				must: [{ match: { streamId } }, { match: { 'metadata.version': version } }],
			},
		};

		const { body } = await this.client.search({
			index: collection,
			body: { query },
		});

		const entity: ElasticsearchEventEntity = body.hits.hits[0];

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return EventEnvelope.from(entity._source.event, entity._source.payload, {
			...entity._source.metadata,
			occurredOn: new Date(entity._source.metadata.occurredOn),
		});
	}
}
