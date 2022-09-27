import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { EventMap } from '../../event-map';
import { EventFilter, EventStore, StreamEventFilter } from '../../event-store';
import { EventNotFoundException } from '../../exceptions';
import { EventEnvelopeMetadata, IEvent, IEventCollection, IEventPayload, IEventPool } from '../../interfaces';
import { EventCollection, EventEnvelope, EventStream } from '../../models';

export type InMemoryEventEntity =
	& {
		streamId: string;
		event: string;
		payload: IEventPayload<IEvent>;
	}
	& EventEnvelopeMetadata;

export class InMemoryEventStore extends EventStore {
	private collections: Map<IEventCollection, InMemoryEventEntity[]> = new Map();

	constructor(readonly eventMap: EventMap) {
		super();
	}

	setup(pool?: IEventPool): EventCollection {
		const collection = EventCollection.get(pool);
		this.collections.set(collection, []);
		return collection;
	}

	async *getEvents(filter?: EventFilter): AsyncGenerator<IEvent[]> {
		let entities: InMemoryEventEntity[] = [];

		let collection = EventCollection.get(filter?.pool);
		let eventStream = filter?.eventStream;
		let fromVersion = eventStream && ((filter as StreamEventFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		if (eventStream) {
			const { streamId } = eventStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (fromVersion) {
			entities = entities.filter(({ version }) => version >= fromVersion);
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

	getEvent({ streamId }: EventStream, version: number, pool?: IEventPool): IEvent {
		const collection = EventCollection.get(pool);
		const eventCollection = this.collections.get(collection) || [];

		let entity = eventCollection.find(
			({ streamId: eventStreamId, version: aggregateVersion }) =>
				eventStreamId === streamId && aggregateVersion === version,
		);

		if (!entity) {
			throw new EventNotFoundException(streamId, version);
		}

		return this.eventMap.deserializeEvent(entity.event, entity.payload);
	}

	appendEvents(
		{ streamId, aggregateId }: EventStream,
		aggregateVersion: number,
		events: IEvent[],
		pool?: IEventPool,
	): void {
		const collection = EventCollection.get(pool);
		const eventCollection = this.collections.get(collection) || [];

		let version = aggregateVersion - events.length + 1;
		const envelopes = events.reduce<EventEnvelope[]>((acc, event) => {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.create(name, payload, { aggregateId, version: version++ });
			return [...acc, envelope];
		}, []);

		eventCollection.push(
			...envelopes.map(({ event, payload, metadata }) => ({ streamId, event, payload, ...metadata })),
		);
	}

	async *getEnvelopes(filter?: EventFilter): AsyncGenerator<EventEnvelope[]> {
		let entities: InMemoryEventEntity[] = [];

		const collection = EventCollection.get(filter?.pool);
		let eventStream = filter?.eventStream && filter.eventStream;
		let fromVersion = eventStream && ((filter as StreamEventFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		if (eventStream) {
			const { streamId } = eventStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (fromVersion) {
			entities = entities.filter(({ version }) => version >= fromVersion);
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
			yield chunk.map(
				({ event, payload, eventId, aggregateId, version, occurredOn, correlationId, causationId }) =>
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

		let entity = eventCollection.find(
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
