import { StreamReadingDirection } from '../../constants';
import { EventMap } from '../../event-map';
import { EventFilter, EventStore } from '../../event-store';
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

	getEvents(filter?: EventFilter): IEvent[] {
		let entities: InMemoryEventEntity[] = [];

		if (filter?.eventStream) {
			const { collection, streamId } = filter.eventStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (filter?.fromVersion) {
			const startEventIndex = entities.findIndex(({ metadata }) => metadata.version === filter.fromVersion);
			entities = startEventIndex === -1 ? [] : entities.slice(startEventIndex);
		}

		if (filter?.direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		return entities.map(({ event, payload }) => this.eventMap.deserializeEvent(event, payload));
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

	getEnvelopes(filter?: EventFilter): EventEnvelope[] {
		let entities: InMemoryEventEntity[] = [];

		if (filter?.eventStream) {
			const { collection, streamId } = filter.eventStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (filter?.fromVersion) {
			const startEventIndex = entities.findIndex(({ metadata }) => metadata.version === filter.fromVersion);
			entities = startEventIndex === -1 ? [] : entities.slice(startEventIndex);
		}

		if (filter?.direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		return entities.map(({ event, payload, metadata }) => EventEnvelope.from(event, payload, metadata));
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
