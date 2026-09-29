import { setTimeout as sleep } from 'node:timers/promises';
import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ANY_MAX_ATTEMPTS, ExpectedVersion } from './constants.js';
import {
	EventSourcingErrorCode,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	InvalidAppendOptionsException,
	isEventSourcingError,
} from './exceptions/index.js';
import type {
	AppendOptions,
	EventSourcingModuleOptions,
	EventStoreCapabilities,
	EventStoreContext,
	IEvent,
	IEventCollection,
	IEventCollectionFilter,
	IEventFilter,
	IEventPool,
	IReadAllFilter,
	PersistOutcome,
	PersistTarget,
} from './interfaces/index.js';
import { EventCollection, EventEnvelope, EventId, type EventStream } from './models/index.js';
import { type AppendItem, normalizeAppendArguments } from './stores/append-arguments.js';
import {
	validateAppendMetadata,
	validateEnvelopeLimits,
	validatePrebuiltEnvelopes,
} from './stores/append-validation.js';
import { resolveCapabilities } from './stores/capabilities.js';
import { EVENT_STORE_BASE } from './stores/implementation-guard.js';

const describeError = (error: unknown): string =>
	error instanceof Error ? error.stack || error.message : String(error);

const isPresent = <T>(value: T | null | undefined): value is T => value !== undefined && value !== null;

/**
 * A frozen copy of headers with at least one key; empty headers carry nothing and are not stored. A copy, taken right
 * after the headers were checked, so that changing the caller's object while the append runs (or a subscriber changing
 * the published envelopes) can't change what is stored, or leak into other appends.
 */
const presentHeaders = (headers: unknown): EventEnvelope['metadata']['headers'] | undefined =>
	typeof headers === 'object' && headers !== null && Object.keys(headers).length > 0
		? Object.freeze({ ...(headers as NonNullable<EventEnvelope['metadata']['headers']>) })
		: undefined;

/**
 * The base class of every event store. It implements the store contract once, for every store:
 * `appendEvents` validates, serializes, checks the expected version, retries `ExpectedVersion.Any`, stamps the global
 * positions and publishes; `getEvent` and `getEvents` deserialize what `getEnvelope` and `getEnvelopes` read.
 *
 * A store implements the driver methods: `connect`, `disconnect`, `ensureCollection`, `listCollections`,
 * `getStreamVersion`, `getEnvelope`, `getEnvelopes`, `readAll` and `persistEvents`, and declares its `capabilities`.
 * It must not override `appendEvents`, `getEvent` or `getEvents`; to decorate appends, override `persistEvents` and
 * call `super`.
 *
 * In the `EventSourcingModule`, the module connects the store while the application bootstraps, and the store
 * disconnects in `onApplicationShutdown`, after the `EventBus` has waited for the running publishers and subscribers.
 */
export abstract class EventStore<
	TOptions = Omit<EventSourcingModuleOptions['eventStore'], 'driver' | 'useDefaultPool'>,
> implements OnApplicationShutdown {
	protected readonly logger = new Logger(this.constructor.name);

	/**
	 * The optional guarantees of the store; `resolveCapabilities` fills in the defaults. Final once `connect()` resolved.
	 */
	readonly capabilities: EventStoreCapabilities = {};

	/**
	 * One monotonic factory per store, so that the event ids of the store's appends are ordered like the appends.
	 */
	private readonly nextEventId = EventId.factory();

	constructor(
		protected readonly context: EventStoreContext,
		protected readonly options: TOptions,
	) {}

	/**
	 * Appends events to a stream, all or nothing, and publishes their envelopes.
	 *
	 * ```ts
	 * await eventStore.appendEvents(stream, events, { expectedVersion: ExpectedVersion.NoStream });
	 * await eventStore.appendEvents(stream, events, { expectedVersion: lastReadVersion, pool: tenantId });
	 * ```
	 *
	 * - `expectedVersion` is the version of the stream before the append (`ExpectedVersion.NoStream`, 0, for a new
	 *   stream). When the stream is at another version, the append throws an `EventStoreVersionConflictException` and
	 *   writes nothing. `ExpectedVersion.Any` appends after whatever the stream holds; it makes up to
	 *   `ANY_MAX_ATTEMPTS` (16) attempts while concurrent appends take the versions, and can still conflict under
	 *   sustained contention on one stream, so retry such a conflict in the application.
	 * - Pre-built envelopes (imports, copies) keep their id, time, correlation id, causation id, headers and event
	 *   version. They need a numeric expected version, the aggregate id of the stream and the versions that continue
	 *   it, like every item: the item at index `i` gets version `expectedVersion + 1 + i`.
	 * - `metadata` applies to every event, and fills only the fields a pre-built envelope lacks. Headers need a store
	 *   with the `headers` capability.
	 * - An empty append returns `[]` without any I/O, once its options and metadata are checked.
	 * - The returned envelopes carry their `globalPosition`. Unless `publish` is `false`, they are published once
	 *   stored; publishing never makes the append fail.
	 *
	 * @throws InvalidAppendOptionsException, InvalidEventMetadataException, InvalidEventEnvelopeException or
	 * UnsupportedOperationException before any I/O, when the arguments are invalid
	 * @throws EventSourcingNotReadyException before any I/O, when called while Nest is still instantiating the providers
	 * (from a provider factory or a constructor)
	 * @throws EventStoreVersionConflictException when the stream is not at the expected version
	 * @throws EventStorePersistenceException when the append failed otherwise; its `outcome` says whether the events
	 * may have been stored
	 */
	appendEvents(
		stream: EventStream,
		events: readonly (IEvent | EventEnvelope)[],
		options: AppendOptions,
	): Promise<EventEnvelope[]>;
	/**
	 * Appends events to a stream in the 3.x form, where `aggregateVersion` is the version of the aggregate after the
	 * append: the stream is expected at `aggregateVersion - events.length`, and the append works like the options form
	 * with that expected version. Emits a `DeprecationWarning` (`OCODA_ES_POSITIONAL_APPEND`) once per process.
	 * @deprecated Use `appendEvents(stream, events, { expectedVersion, pool })`. Removed in 5.0.
	 */
	appendEvents(
		stream: EventStream,
		aggregateVersion: number,
		events: readonly (IEvent | EventEnvelope)[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]>;
	async appendEvents(stream: EventStream, ...args: unknown[]): Promise<EventEnvelope[]> {
		const { items, expectedVersion, pool, metadata, publish } = normalizeAppendArguments(args);
		const capabilities = resolveCapabilities(this.capabilities);
		const component = this.constructor.name;
		// Before the empty check, so that invalid metadata fails the same way whatever the number of events
		validateAppendMetadata(metadata, capabilities, { component });
		if (items.length === 0) {
			return [];
		}

		const options = (metadata ?? {}) as NonNullable<AppendOptions['metadata']>;
		// The stream's own limits first: they don't depend on the events, so they fail before any serialization
		validateEnvelopeLimits(stream, []);
		validatePrebuiltEnvelopes(stream, items, expectedVersion);
		for (const item of items) {
			if (item instanceof EventEnvelope) {
				const { correlationId, causationId, headers } = item.metadata;
				validateAppendMetadata({ correlationId, causationId, headers }, capabilities, {
					allowReservedKeys: true,
					component,
				});
			}
		}
		// From a provider factory, this throws EventSourcingNotReadyException before any I/O, even for pre-built
		// envelopes, which need no EventMap lookup: the publishers would miss the committed events (ADR 0001 §3)
		this.context.eventMap.ensureRegistered('EventStore.appendEvents');

		// Numbered from `expectedVersion`; an append with ExpectedVersion.Any is renumbered once the head is known
		const firstVersion = expectedVersion === ExpectedVersion.Any ? 1 : expectedVersion + 1;
		const drafts = items.map((item, index) => this.draftOf(stream, item, firstVersion + index, options));
		validateEnvelopeLimits(stream, drafts);

		const collection = EventCollection.get(pool);
		for (let attempt = 1; ; attempt++) {
			const head = await this.readHead(stream, pool, collection);
			if (expectedVersion !== ExpectedVersion.Any && head !== expectedVersion) {
				throw new EventStoreVersionConflictException({ stream, expectedVersion, actualVersion: head, pool });
			}

			const envelopes =
				expectedVersion === ExpectedVersion.Any
					? drafts.map((draft, index) => renumber(draft, head + 1 + index))
					: drafts;

			const outcome = await this.persist(envelopes, { stream, collection, expectedVersion: head, pool });
			if (outcome.status === 'committed') {
				const committed = this.stampPositions(envelopes, outcome.positions, collection);
				if (publish) {
					await this.publishCommitted(committed);
				}
				return committed;
			}

			if (expectedVersion === ExpectedVersion.Any && attempt < ANY_MAX_ATTEMPTS) {
				// Jittered backoff, so that the writers that lost the race don't collide again right away
				await sleep(Math.random() * Math.min(100, 2 ** attempt));
				continue;
			}
			throw new EventStoreVersionConflictException(
				{ stream, expectedVersion, actualVersion: outcome.actualVersion, pool },
				outcome.cause === undefined ? undefined : { cause: outcome.cause },
			);
		}
	}

	/**
	 * Reads an event of a stream.
	 * @throws EventSourcingNotReadyException before any I/O, when called while Nest is still instantiating the providers
	 * @throws EventNotFoundException when the stream has no event with that version
	 * @throws EventCollectionNotFoundException when the pool's collection doesn't exist
	 */
	async getEvent(stream: EventStream, version: number, pool?: IEventPool): Promise<IEvent> {
		this.context.eventMap.ensureRegistered('EventStore.getEvent');
		const { event, payload } = await this.getEnvelope(stream, version, pool);
		return this.context.eventMap.deserializeEvent(event, payload);
	}

	/**
	 * Reads the events of a stream, in batches.
	 * @throws EventSourcingNotReadyException before any I/O, when called while Nest is still instantiating the providers
	 * @throws EventCollectionNotFoundException when the pool's collection doesn't exist
	 */
	async *getEvents(stream: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]> {
		this.context.eventMap.ensureRegistered('EventStore.getEvents');
		for await (const envelopes of this.getEnvelopes(stream, filter)) {
			yield envelopes.map(({ event, payload }) => this.context.eventMap.deserializeEvent(event, payload));
		}
	}

	/**
	 * Disconnects the store when the application shuts down. Nest calls it after `beforeApplicationShutdown`, where the
	 * `EventBus` waits for the running publishers and subscribers, so they aren't cut off. A failure is logged, so that
	 * the rest of the application still shuts down.
	 */
	async onApplicationShutdown(): Promise<void> {
		try {
			await this.disconnect();
		} catch (error) {
			this.logger.error('Failed to disconnect the event store', describeError(error));
		}
	}

	/**
	 * Connects to the database. The store's capabilities are final once it resolved.
	 */
	abstract connect(): Promise<void>;

	/**
	 * Disconnects from the database.
	 */
	abstract disconnect(): Promise<void>;

	/**
	 * Creates the collection (table) of a pool, unless it exists. Never touches existing events.
	 * @param pool The event pool, `undefined` for the default pool.
	 * @returns The event collection.
	 */
	abstract ensureCollection(pool?: IEventPool): Promise<IEventCollection>;

	/**
	 * Lists the event collections, in batches.
	 */
	abstract listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]>;

	/**
	 * Reads the envelope of an event of a stream, with its `globalPosition`.
	 * @throws EventNotFoundException when the stream has no event with that version
	 * @throws EventCollectionNotFoundException when the pool's collection doesn't exist
	 */
	abstract getEnvelope(stream: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope>;

	/**
	 * Reads the envelopes of a stream, in batches, with their `globalPosition`.
	 * @throws EventCollectionNotFoundException when the pool's collection doesn't exist
	 */
	abstract getEnvelopes(stream: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]>;

	/**
	 * Reads the version of a stream: the version of its last event, 0 when it has none.
	 * @throws EventCollectionNotFoundException when the pool's collection doesn't exist
	 */
	abstract getStreamVersion(stream: EventStream, pool?: IEventPool): Promise<number>;

	/**
	 * Reads the envelopes of a pool across streams, in the order of their global position, in batches. `fromPosition`
	 * is inclusive: resume after a checkpoint with `fromPosition: checkpoint + 1n`.
	 * @throws EventCollectionNotFoundException when the pool's collection doesn't exist
	 */
	abstract readAll(filter?: IReadAllFilter): AsyncGenerator<EventEnvelope[]>;

	/**
	 * Stores the envelopes of an append, all or nothing, and assigns their global positions. The envelopes are
	 * serialized, validated and numbered: the first one has version `target.expectedVersion + 1`.
	 *
	 * - Returns `{ status: 'committed', positions }`, one position per envelope, consecutive, in order.
	 * - Returns `{ status: 'conflict', cause }` when another append already took one of the versions, as the unique
	 *   (stream, version) key reports it, and nothing was stored.
	 * - Throws an `EventStorePersistenceException` for every other failure, with `outcome: 'not-persisted'` when
	 *   nothing was written (the collection doesn't exist, the connection failed before the commit, ...), and
	 *   `outcome: 'unknown'` when the commit may have happened. Any other error it throws counts as `'unknown'`.
	 *
	 * It checks no versions and serializes nothing; the base class does. Never overwrites an event.
	 */
	protected abstract persistEvents(envelopes: readonly EventEnvelope[], target: PersistTarget): Promise<PersistOutcome>;

	/**
	 * The envelope an item of an append is stored as: a new envelope for an event, or a copy of a pre-built envelope
	 * with the gaps filled from the append's metadata. Never modifies the item.
	 */
	private draftOf(
		stream: EventStream,
		item: AppendItem,
		version: number,
		metadata: NonNullable<AppendOptions['metadata']>,
	): EventEnvelope {
		if (item instanceof EventEnvelope) {
			const { eventId, occurredOn, correlationId, causationId, headers, eventVersion } = item.metadata;
			return EventEnvelope.from(item.event, item.payload, {
				eventId,
				aggregateId: stream.aggregateId,
				version,
				occurredOn: occurredOn ?? eventId.date,
				...withPresent('correlationId', correlationId ?? metadata.correlationId),
				...withPresent('causationId', causationId ?? metadata.causationId),
				...withPresent('headers', presentHeaders(headers) ?? presentHeaders(metadata.headers)),
				...withPresent('eventVersion', eventVersion),
			});
		}

		if (typeof item !== 'object' || item === null) {
			throw new InvalidAppendOptionsException({
				option: 'events',
				value: item,
				reason: 'every item must be an event instance or an EventEnvelope',
			});
		}
		const { eventMap } = this.context;
		const eventId = this.nextEventId();
		return EventEnvelope.from(eventMap.getName(item), eventMap.serializeEvent(item), {
			eventId,
			aggregateId: stream.aggregateId,
			version,
			occurredOn: eventId.date,
			...withPresent('correlationId', metadata.correlationId),
			...withPresent('causationId', metadata.causationId),
			...withPresent('headers', presentHeaders(metadata.headers)),
		});
	}

	/**
	 * The version of the stream before an attempt. A failure here happens before anything is written.
	 */
	private async readHead(stream: EventStream, pool: IEventPool | undefined, collection: IEventCollection) {
		let head: unknown;
		try {
			head = await this.getStreamVersion(stream, pool);
		} catch (error) {
			throw new EventStorePersistenceException({ collection, outcome: 'not-persisted' }, { cause: error });
		}
		if (!Number.isSafeInteger(head) || (head as number) < 0) {
			throw new EventStorePersistenceException(
				{ collection, outcome: 'not-persisted' },
				{ cause: new TypeError(`getStreamVersion returned ${String(head)}, not the version of the stream`) },
			);
		}
		return head as number;
	}

	/**
	 * Calls `persistEvents`: its `EventStorePersistenceException` passes through, any other error (or a result that is
	 * not an outcome) may have happened after the commit, so it becomes an `'unknown'` outcome.
	 */
	private async persist(envelopes: readonly EventEnvelope[], target: PersistTarget): Promise<PersistOutcome> {
		let outcome: PersistOutcome;
		try {
			outcome = await this.persistEvents(envelopes, target);
		} catch (error) {
			if (isEventSourcingError(error, EventSourcingErrorCode.EventStorePersistence)) {
				throw error;
			}
			throw new EventStorePersistenceException({ collection: target.collection, outcome: 'unknown' }, { cause: error });
		}
		if (outcome?.status !== 'committed' && outcome?.status !== 'conflict') {
			throw new EventStorePersistenceException(
				{ collection: target.collection, outcome: 'unknown' },
				{ cause: new TypeError(`persistEvents returned ${describeOutcome(outcome)}, not a PersistOutcome`) },
			);
		}
		return outcome;
	}

	/**
	 * The committed envelopes with their global positions. The events are stored, so positions that break the contract
	 * are logged and never thrown: envelopes get positions only when every position is a bigint.
	 */
	private stampPositions(
		envelopes: readonly EventEnvelope[],
		positions: readonly unknown[] | undefined,
		collection: IEventCollection,
	): EventEnvelope[] {
		const valid =
			Array.isArray(positions) &&
			positions.length === envelopes.length &&
			positions.every((position) => typeof position === 'bigint');
		if (!valid) {
			this.logger.error(
				`persistEvents committed ${envelopes.length} event(s) to ${collection} but returned ${Array.isArray(positions) ? `${positions.length} position(s) that are not all bigints` : 'no positions'}; the returned envelopes have no global position`,
			);
			return [...envelopes];
		}
		const increasing = positions.every((position, index) => index === 0 || position > positions[index - 1]);
		if (!increasing) {
			this.logger.error(
				`persistEvents committed ${envelopes.length} event(s) to ${collection} with global positions that don't strictly increase: ${positions.join(', ')}`,
			);
		}
		return envelopes.map((envelope, index) => envelope.withGlobalPosition(positions[index] as bigint));
	}

	/**
	 * Publishes committed envelopes. The events are stored, so a failing publisher is logged, never thrown.
	 */
	private async publishCommitted(envelopes: readonly EventEnvelope[]): Promise<void> {
		try {
			await this.context.publisher.publishAll(envelopes);
		} catch (error) {
			this.logger.error(`Failed to publish ${envelopes.length} appended event(s)`, describeError(error));
		}
	}
}

// The walk of the implementation guard up a store's prototype chain stops here
Object.defineProperty(EventStore.prototype, EVENT_STORE_BASE, { value: true });

const withPresent = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
	(isPresent(value) ? { [key]: value } : {}) as { [P in K]?: V };

/**
 * A copy of a draft with another version, for an append with `ExpectedVersion.Any`: same id and time.
 */
const renumber = (draft: EventEnvelope, version: number): EventEnvelope =>
	EventEnvelope.from(draft.event, draft.payload, { ...draft.metadata, version });

const describeOutcome = (outcome: unknown): string => {
	if (outcome === null || typeof outcome !== 'object') {
		return String(outcome);
	}
	const status = (outcome as { status?: unknown }).status;
	return `an object with status ${typeof status === 'string' ? JSON.stringify(status) : String(status)}`;
};
