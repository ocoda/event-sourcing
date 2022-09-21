import { EventStream, EventEnvelope, Id } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';
import { EventNotFoundException } from '../../exceptions';
import { EventMap } from '../../event-map';
import { EventEnvelopeMetadata, IEvent, IEventCollection, IEventPayload, IEventPool } from '../../interfaces';

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

	getEvents(
		{ collection, streamId }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): IEvent[] {
		const eventCollection = this.collections.get(collection) || [];

		let entities = eventCollection.filter(({ streamId: entityStreamId }) => entityStreamId === streamId);

		if (fromVersion) {
			const startEventIndex = entities.findIndex(({ metadata }) => metadata.version === fromVersion);
			entities = startEventIndex === -1 ? [] : entities.slice(startEventIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
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

	getEnvelopes(
		{ collection, streamId }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): EventEnvelope[] {
		const eventCollection = this.collections.get(collection) || [];

		let entities = eventCollection.filter(({ streamId: entityStreamId }) => entityStreamId === streamId);

		if (fromVersion) {
			const startEventIndex = entities.findIndex(({ metadata }) => metadata.version === fromVersion);
			entities = startEventIndex === -1 ? [] : entities.slice(startEventIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		return entities.map(({ event, payload, metadata }) => {
			return EventEnvelope.from(event, payload, metadata);
		});
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
