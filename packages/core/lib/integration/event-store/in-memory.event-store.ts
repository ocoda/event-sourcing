import type { Type } from '@nestjs/common';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { type EventFilter, EventStore } from '../../event-store';
import { EventNotFoundException, EventStorePersistenceException } from '../../exceptions';
import type {
	EventEnvelopeMetadata,
	EventStoreConfig,
	IEvent,
	IEventCollection,
	IEventPayload,
	IEventPool,
} from '../../interfaces';
import { EventCollection, EventEnvelope, type EventStream } from '../../models';

export type InMemoryEventEntity = {
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
} & EventEnvelopeMetadata;

export interface InMemoryEventStoreConfig extends EventStoreConfig {
	driver: Type<InMemoryEventStore>;
}

export class InMemoryEventStore extends EventStore<InMemoryEventStoreConfig> {
	public collections: Map<IEventCollection, InMemoryEventEntity[]>;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.collections = new Map();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.collections.clear();
	}

	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);
		this.collections.set(collection, []);
		return collection;
	}

	async *getEvents({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<IEvent[]> {
		let entities: InMemoryEventEntity[] = [];
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);

		if (fromVersion) {
			entities = entities.filter(({ version }) => version >= fromVersion);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		if (limit) {
			entities = entities.slice(0, limit);
		}

		for (let i = 0; i < entities.length; i += batch) {
			const chunk = entities.slice(i, i + batch);
			yield chunk.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload));
		}
	}

	getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): IEvent {
		const collection = EventCollection.get(pool);
		const eventCollection = this.collections.get(collection) || [];

		const entity = eventCollection.find(
			({ streamId: eventStreamId, version: aggregateVersion }) =>
				eventStreamId === streamId && aggregateVersion === version,
		);

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

		try {
			const eventCollection = this.collections.get(collection);

			if (!eventCollection) {
				throw new Error('Event collection not found');
			}

			let version = aggregateVersion - events.length + 1;

			const envelopes: EventEnvelope[] = [];
			for (const event of events) {
				const name = this.eventMap.getName(event);
				const payload = this.eventMap.serializeEvent(event);
				const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
				envelopes.push(envelope);
			}

			eventCollection.push(
				...envelopes.map(({ event, payload, metadata }) => ({ streamId, event, payload, ...metadata })),
			);

			return Promise.resolve(envelopes);
		} catch (error) {
			throw new EventStorePersistenceException(collection, error);
		}
	}

	async *getEnvelopes({ streamId }: EventStream, filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		let entities: InMemoryEventEntity[] = [];
		const collection = EventCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);

		if (fromVersion) {
			entities = entities.filter(({ version }) => version >= fromVersion);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		if (limit) {
			entities = entities.slice(0, limit);
		}

		for (let i = 0; i < entities.length; i += batch) {
			const chunk = entities.slice(i, i + batch);
			yield chunk.map(({ event, payload, eventId, aggregateId, version, occurredOn, correlationId, causationId }) =>
				EventEnvelope.from(event, payload, {
					eventId,
					aggregateId,
					version,
					occurredOn,
					correlationId,
					causationId,
				}),
			);
		}
	}

	getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): EventEnvelope {
		const collection = EventCollection.get(pool);
		const eventCollection = this.collections.get(collection) || [];

		const entity = eventCollection.find(
			({ streamId: eventStreamId, version: aggregateVersion }) =>
				eventStreamId === streamId && aggregateVersion === version,
		);

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
