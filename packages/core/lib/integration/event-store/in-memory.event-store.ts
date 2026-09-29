import type { Type } from '@nestjs/common';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants.js';
import { EventStore } from '../../event-store.js';
import {
	EventCollectionNotFoundException,
	EventNotFoundException,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
} from '../../exceptions/index.js';
import type {
	EventEnvelopeMetadata,
	EventStoreCapabilities,
	EventStoreConfig,
	IEvent,
	IEventCollection,
	IEventCollectionFilter,
	IEventFilter,
	IEventPayload,
	IEventPool,
	IReadAllFilter,
	PersistOutcome,
	PersistTarget,
} from '../../interfaces/index.js';
import { EventCollection, EventEnvelope, type EventStream } from '../../models/index.js';
import { toBatchSize, toPosition } from '../../stores/positions.js';

export type InMemoryEventEntity = {
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
} & EventEnvelopeMetadata;

export interface InMemoryEventStoreConfig extends EventStoreConfig {
	driver: Type<InMemoryEventStore>;
}

/**
 * An event store that keeps the events of each pool in an array, in the order of their global position. For tests and
 * prototypes: everything is lost on `disconnect()` or a new `connect()`.
 *
 * Appends are atomic and serialized per process (nothing is awaited between the version check and the write), so the
 * global order is gap-safe.
 */
export class InMemoryEventStore extends EventStore<InMemoryEventStoreConfig> {
	override readonly capabilities: EventStoreCapabilities = {
		atomicAppend: true,
		headers: true,
		globalOrder: 'gap-safe',
	};

	/**
	 * The events of each collection, in the order of their global position.
	 */
	public collections: Map<IEventCollection, InMemoryEventEntity[]>;

	/**
	 * The last global position each collection handed out. Never decreases, so a position is never reused.
	 */
	protected lastPositions: Map<IEventCollection, bigint> = new Map();

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.collections = new Map();
		this.lastPositions = new Map();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.collections?.clear();
		this.lastPositions.clear();
	}

	public async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		const collection = EventCollection.get(pool);
		try {
			// Only create the collection when it doesn't exist yet, never wipe existing events
			if (!this.collections.has(collection)) {
				this.collections.set(collection, []);
			}
			return collection;
		} catch (error) {
			throw new EventStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	public async *listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		const collections = [...(this.collections?.keys() ?? [])];

		for (let i = 0; i < collections.length; i += batch) {
			yield collections.slice(i, i + batch);
		}
	}

	public async getStreamVersion({ streamId }: EventStream, pool?: IEventPool): Promise<number> {
		return versionOf(this.entitiesOf(pool), streamId);
	}

	public async getEnvelope({ streamId }: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const entity = this.entitiesOf(pool).find(
			(candidate) => candidate.streamId === streamId && candidate.version === version,
		);
		if (!entity) {
			throw new EventNotFoundException({ streamId, version, pool });
		}
		return toEnvelope(entity);
	}

	public async *getEnvelopes({ streamId }: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		let entities = this.entitiesOf(filter?.pool).filter((entity) => entity.streamId === streamId);
		if (fromVersion) {
			entities = entities.filter(({ version }) => version >= fromVersion);
		}
		// By version, whatever order the (imported) events were appended in
		entities.sort((a, b) => a.version - b.version);
		if (direction === StreamReadingDirection.BACKWARD) {
			entities.reverse();
		}
		entities = entities.slice(0, limit);

		for (let i = 0; i < entities.length; i += batch) {
			yield entities.slice(i, i + batch).map(toEnvelope);
		}
	}

	/**
	 * Reads the events of a pool in the order of their global position. Each batch is read after the previous one was
	 * consumed, from the position after its last event, so events appended in the meantime are read too.
	 */
	public async *readAll(filter?: IReadAllFilter): AsyncGenerator<EventEnvelope[]> {
		const batch = toBatchSize(filter?.batch);
		let fromPosition = filter?.fromPosition === undefined ? 0n : toPosition(filter.fromPosition);

		while (true) {
			const entities = this.entitiesOf(filter?.pool);
			const start = firstAtOrAfter(entities, fromPosition);
			const chunk = entities.slice(start, start + batch);
			if (chunk.length === 0) {
				return;
			}
			yield chunk.map(toEnvelope);
			if (chunk.length < batch) {
				return;
			}
			fromPosition = (chunk[chunk.length - 1].globalPosition as bigint) + 1n;
		}
	}

	/**
	 * Stores the envelopes and assigns their positions. Nothing is awaited from the collection check to the write, so
	 * the append is atomic, and no other append can come in between.
	 */
	protected async persistEvents(
		envelopes: readonly EventEnvelope[],
		{ stream, collection, pool }: PersistTarget,
	): Promise<PersistOutcome> {
		const entities = this.collections?.get(collection);
		if (!entities) {
			throw new EventStorePersistenceException(
				{ collection, outcome: 'not-persisted' },
				{ cause: new EventCollectionNotFoundException({ collection, pool }) },
			);
		}

		// Like a unique (stream, version) key: none of the versions may be taken
		const versions = new Set(envelopes.map(({ metadata }) => metadata.version));
		const taken = entities.find((entity) => entity.streamId === stream.streamId && versions.has(entity.version));
		if (taken) {
			return {
				status: 'conflict',
				actualVersion: versionOf(entities, stream.streamId),
				cause: new Error(`Duplicate key (${stream.streamId}, ${taken.version}) in the ${collection} collection`),
			};
		}

		let position = this.lastPositions.get(collection) ?? 0n;
		const positions = envelopes.map(() => ++position);
		entities.push(...envelopes.map((envelope, index) => toEntity(stream, envelope, positions[index])));
		this.lastPositions.set(collection, position);

		return { status: 'committed', positions };
	}

	/**
	 * The events of a pool.
	 * @throws EventCollectionNotFoundException when the pool's collection doesn't exist
	 */
	protected entitiesOf(pool?: IEventPool): InMemoryEventEntity[] {
		const collection = EventCollection.get(pool);
		const entities = this.collections?.get(collection);
		if (!entities) {
			throw new EventCollectionNotFoundException({ collection, pool });
		}
		return entities;
	}
}

const versionOf = (entities: readonly InMemoryEventEntity[], streamId: string): number =>
	entities.reduce((max, entity) => (entity.streamId === streamId && entity.version > max ? entity.version : max), 0);

/**
 * The index of the first entity at or after the position (binary search: the positions increase with the index).
 */
const firstAtOrAfter = (entities: readonly InMemoryEventEntity[], position: bigint): number => {
	let low = 0;
	let high = entities.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((entities[middle].globalPosition as bigint) < position) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
};

const toEntity = (stream: EventStream, { event, payload, metadata }: EventEnvelope, globalPosition: bigint) => {
	const { eventId, aggregateId, version, occurredOn, correlationId, causationId, headers, eventVersion } = metadata;
	const entity: InMemoryEventEntity = {
		streamId: stream.streamId,
		event,
		payload,
		eventId,
		aggregateId,
		version,
		occurredOn,
		globalPosition,
	};
	if (correlationId !== undefined) entity.correlationId = correlationId;
	if (causationId !== undefined) entity.causationId = causationId;
	// A copy, so that changing the headers object after the append doesn't change the stored event
	if (headers !== undefined) entity.headers = Object.freeze({ ...headers });
	if (eventVersion !== undefined) entity.eventVersion = eventVersion;
	return entity;
};

const toEnvelope = ({ event, payload, streamId: _, ...metadata }: InMemoryEventEntity): EventEnvelope =>
	EventEnvelope.from(event, payload, metadata);
