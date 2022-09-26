import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { EventMap } from '../../event-map';
import { EventFilter, EventStore, StreamEventFilter } from '../../event-store';
import { EventNotFoundException } from '../../exceptions';
import { EventEnvelopeMetadata, IEvent, IEventCollection, IEventPayload, IEventPool } from '../../interfaces';
import { EventEnvelope, EventStream } from '../../models';

interface InMemoryEventEntity {
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
	metadata: EventEnvelopeMetadata;
}

export class InMemoryEventStore extends EventStore {
	private collections: Map<IEventCollection, InMemoryEventEntity[]> = new Map();

	constructor(readonly eventMap: EventMap) {
		super();
	}

	setup(pool?: IEventPool): void {
		this.collections.set(pool ? `${pool}-events` : 'events', []);
	}

	async *getEvents(filter?: EventFilter): AsyncGenerator<IEvent[]> {
		let entities: InMemoryEventEntity[] = [];

		let eventStream = filter?.eventStream;
		let fromVersion = eventStream && ((filter as StreamEventFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		if (eventStream) {
			const { collection, streamId } = eventStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (fromVersion) {
			entities = entities.filter(({ metadata }) => metadata.version >= fromVersion);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		if (skip) {
			entities = entities.slice(skip);
		}

		if (limit) {
			entities = entities.slice(0, limit);
		}

		for (let i = 0; i < entities.length; i += batch) {
			const chunk = entities.slice(i, i + batch);
			yield chunk.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload));
		}
	}

	getEvent({ collection, streamId }: EventStream, version: number): IEvent {
		const eventCollection = this.collections.get(collection) || [];

		let entity = eventCollection.find(
			({ streamId: eventStreamId, metadata }) => eventStreamId === streamId && metadata.version === version,
		);

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	appendEvents({ collection, streamId, aggregateId }: EventStream, aggregateVersion: number, events: IEvent[]): void {
		const eventCollection = this.collections.get(collection) || [];

		let version = aggregateVersion - events.length + 1;
		const envelopes = events.reduce<EventEnvelope[]>((acc, event) => {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
			return [...acc, envelope];
		}, []);

		eventCollection.push(...envelopes.map(({ event, payload, metadata }) => ({ streamId, event, payload, metadata })));
	}

	async *getEnvelopes(filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		let entities: InMemoryEventEntity[] = [];

		let eventStream = filter?.eventStream && filter.eventStream;
		let fromVersion = eventStream && ((filter as StreamEventFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		if (eventStream) {
			const { collection, streamId } = eventStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (fromVersion) {
			entities = entities.filter(({ metadata }) => metadata.version >= fromVersion);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		if (skip) {
			entities = entities.slice(skip);
		}

		if (limit) {
			entities = entities.slice(0, limit);
		}

		for (let i = 0; i < entities.length; i += batch) {
			const chunk = entities.slice(i, i + batch);
			yield chunk.map(({ event, payload, metadata }) => EventEnvelope.create(event, payload, metadata));
		}
	}

	getEnvelope({ collection, streamId }: EventStream, version: number): EventEnvelope {
		const eventCollection = this.collections.get(collection) || [];

		let entity = eventCollection.find(
			({ streamId: eventStreamId, metadata }) => eventStreamId === streamId && metadata.version === version,
		);

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return EventEnvelope.from(entity.event, entity.payload, entity.metadata);
	}
}
