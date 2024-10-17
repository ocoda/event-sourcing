import type { Type } from '@nestjs/common';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { EventStore } from '../../event-store';
import {
	EventNotFoundException,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
} from '../../exceptions';
import type {
	EventEnvelopeMetadata,
	EventStoreConfig,
	IAllEventsFilter,
	IEvent,
	IEventCollection,
	IEventCollectionFilter,
	IEventFilter,
	IEventPayload,
	IEventPool,
} from '../../interfaces';
import { EventCollection, EventEnvelope, EventId, type EventStream } from '../../models';

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
		try {
			this.collections.set(collection, []);
			return collection;
		} catch (error) {
			throw new EventStoreCollectionCreationException(collection, error);
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		let collections: IEventCollection[] = [];

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		collections = [...this.collections.keys()];

		for (let i = 0; i < collections.length; i += batch) {
			const chunk = collections.slice(i, i + batch);
			yield chunk;
		}
	}

	async *getEvents({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]> {
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
		stream: EventStream,
		aggregateVersion: number,
		events: IEvent[] | EventEnvelope[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]> {
		const collection = EventCollection.get(pool);

		try {
			const eventCollection = this.collections.get(collection);

			if (!eventCollection) {
				throw new Error('Event collection not found');
			}

			const currentVersion = eventCollection
				.filter(({ streamId: eventStreamId }) => eventStreamId === stream.streamId)
				.reduce((max, { version }) => Math.max(max, version), 0);

			// Ensure the current version matches the aggregateVersion for optimistic locking
			if (aggregateVersion <= currentVersion) {
				throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion);
			}

			let version = aggregateVersion - events.length + 1;

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

			eventCollection.push(
				...envelopes.map(({ event, payload, metadata }) => ({
					streamId: stream.streamId,
					event,
					payload,
					...metadata,
				})),
			);

			return Promise.resolve(envelopes);
		} catch (error) {
			switch (error.constructor) {
				case EventStoreVersionConflictException:
					throw error;
				default:
					throw new EventStorePersistenceException(collection, error);
			}
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

	async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
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

	async *getAllEnvelopes(filter: IAllEventsFilter): AsyncGenerator<EventEnvelope[]> {
		let entities: InMemoryEventEntity[] = [];
		const collection = EventCollection.get(filter?.pool);

		const { since, until } = this.getDateRange(filter.since, filter.until);

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = this.collections
			.get(collection)
			.filter(({ occurredOn }) => {
				const delta = new Date(occurredOn).getTime();
				return since <= delta && delta <= until;
			})
			.sort((a, b) => (a.eventId.value < b.eventId.value ? -1 : 1));

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

	private getDateRange(
		sinceDate: { year: number; month: number },
		untilDate: { year: number; month: number },
	): { since: number; until: number } {
		const now = new Date();
		const [untilYear, untilMonth] = untilDate
			? [untilDate.year, untilDate.month]
			: [now.getFullYear(), now.getMonth() + 1];

		return {
			since: Date.UTC(sinceDate.year, sinceDate.month - 1, 1, 0, 0, 0, 0),
			until: Date.UTC(untilYear, untilMonth, 0, 23, 59, 59, 999),
		};
	}
}
