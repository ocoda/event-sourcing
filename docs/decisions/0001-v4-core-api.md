# ADR 0001: v4 core API

- **Status:** Proposed
- **Date:** 2026-09-29
- **Scope:** plan milestone M6 (b–f), plus the store contract that M7 (schema v2, `global_position`) implements
- **Baseline:** `origin/v4/platform-esm` (#543), which already includes the 3.0.1 fixes
- **Amendments:** 2026-09-29: DynamoDB leaves v4 (#550; 3.x only) because it has no gap-free global order. Its `maxEventsPerAppend` and `globalOrder: 'none'` go too, and `readAll` over a store-assigned `global_position` replaces the year-month API in 4.0 (§9). 2026-09-29, with the §5 PR (pending owner confirmation): `InvalidIdException` keeps `DomainException` as its parent and is branded instead, so `instanceof EventSourcingError` is a brand check; `isEventSourcingError(error, code)` narrows to the class of the code; §1 step 5 keeps a driver's own `outcome` (§5, §1). 2026-09-29, store contract (pending owner confirmation, non-blocking): D1–D32 in [Amendments (store contract)](#amendments-store-contract), and the schema v2 design in [ADR 0002](./0002-schema-v2.md).

## Context

4.0 (NestJS ^12, ESM-only, one schema migration) is the only release allowed to break things. Read-side features (checkpointed subscriptions, projections, the outbox), AsyncLocalStorage (ALS) context and `AggregateRepository` ship in 4.x minors, so 4.0 must keep them additive; for the read side, that means a global position now.

3.x defects that need breaking changes:

- **Concurrency:** drivers get the post-change version and check only `aggregateVersion <= current`. Gaps pass, and unchanged saves throw.
- **All-events reads:** month buckets in event-id order, which is creation order, not commit order, so they can't be checkpointed.
- **Publishing:** a constructor `Proxy` whose publisher is only set in `onApplicationBootstrap`.
- **Registration:** it runs late, uses a static `EventRegistry`, and drops duplicates and request-scoped providers silently.
- **Aggregates:** `commit()` clears events before the append, and `applyEvent` bumps the version before the handler runs.
- **Errors and serialization:** stacks get wiped, and the default serializer is class-transformer. Buses are untyped, and there is no correlation metadata.

This ADR synthesises three proposals (minimal, robust, DX), which three judges verified against the code, `@nestjs/core` 12.1.1 and class-transformer 0.5.1.

## Decision

Principles:

1. Validate before commit; never throw after it.
2. The base class owns semantics; drivers own I/O.
3. Break only what is wrong. Cheap 3.x shapes stay as `@deprecated` shims until 5.0.
4. Keep 4.x additive through option objects, optional capability flags, a context object in the constructor and a reserved namespace for headers.

### 1. Event store and snapshot store contract

```ts
export const ExpectedVersion = { NoStream: 0, Any: 'any' } as const;
export type ExpectedVersion = number | typeof ExpectedVersion.Any; // stream version BEFORE the append

export interface AppendOptions {
	expectedVersion: ExpectedVersion; // required
	pool?: IEventPool;
	metadata?: AppendMetadata; // §8
	publish?: boolean; // default true; false for imports/migrations
}

export interface EventStoreCapabilities {
	// all optional, defaults in the base class
	atomicAppend?: boolean; // true (Mongo standalone: false, documented, not refused)
	headers?: boolean; // false
	globalOrder?: 'gap-safe' | 'best-effort'; // 'best-effort'; built-in stores claim 'gap-safe' where proven (§9; amended by D16, D18)
}

export interface EventStoreContext {
	readonly eventMap: EventMap;
	readonly publisher: EnvelopePublisher; // 4.x may add optional clock/metadata
}

export type PersistOutcome =
	| { status: 'committed'; positions: readonly bigint[] } // one global position per envelope (§9)
	| { status: 'conflict'; actualVersion?: number; cause?: unknown };

export abstract class EventStore<TOptions = unknown> implements OnApplicationShutdown {
	constructor(protected readonly context: EventStoreContext, protected readonly options: TOptions);
	readonly capabilities: EventStoreCapabilities = {};

	// Template methods (overriding fails bootstrap)
	appendEvents(stream: EventStream, events: readonly (IEvent | EventEnvelope)[], options: AppendOptions): Promise<EventEnvelope[]>;
	/** @deprecated 3.x form: expectedVersion = aggregateVersion - events.length. Removed in 5.0. */
	appendEvents(stream: EventStream, aggregateVersion: number, events: readonly (IEvent | EventEnvelope)[], pool?: IEventPool): Promise<EventEnvelope[]>;
	getEvent(stream: EventStream, version: number, pool?: IEventPool): Promise<IEvent>;
	getEvents(stream: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]>;

	// Driver SPI: Promise-only, never touches EventMap; disconnect() runs in onApplicationShutdown
	abstract connect(): Promise<void>;
	abstract disconnect(): Promise<void>;
	abstract ensureCollection(pool?: IEventPool): Promise<IEventCollection>; // listCollections reads the catalog (amended by D17)
	abstract getStreamVersion(stream: EventStream, pool?: IEventPool): Promise<number>; // 0 when absent
	abstract getEnvelope(stream: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope>;
	abstract getEnvelopes(stream: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]>;
	abstract readAll(filter?: IReadAllFilter): AsyncGenerator<EventEnvelope[]>; // replaces getAllEnvelopes (§9)
	/** All or nothing, positions included; never overwrites; a taken (stream, version) returns a conflict. */
	protected abstract persistEvents(
		envelopes: readonly EventEnvelope[],
		target: { stream: EventStream; collection: IEventCollection; expectedVersion: number; pool?: IEventPool },
	): Promise<PersistOutcome>;
}
```

**`appendEvents` template:**

1. Normalise the deprecated form. Return `[]` for an empty append, with no I/O and no publish.
2. Validate `expectedVersion`, the metadata (§8) and pre-built envelopes before any I/O. Pre-built envelopes need a numeric expected version, the stream's `aggregateId` and versions `expected+1…` (`InvalidEventEnvelopeException`). They keep their `eventId` and `occurredOn`, which conformance seeding and imports rely on; the store assigns their position.
3. Serialize through `EventMap`, using one monotonic id factory.
4. Resolve the expected version. A number (0 is `NoStream`) is **pre-checked** against `getStreamVersion()`: a mismatch throws a conflict carrying `actualVersion` and writes nothing. `Any` uses that read.
5. Call `persistEvents` and stamp the returned positions on the envelopes. A conflict under `Any` retries from step 4 (*amended by D2:* up to 16 attempts, same ids); any other conflict throws `EventStoreVersionConflictException`. An `EventStorePersistenceException` from `persistEvents` passes through unchanged, because the driver knows its `outcome` best; any other foreign error becomes `new EventStorePersistenceException({ collection, outcome: 'unknown' }, { cause })`. A failure before `persistEvents`, such as the pre-check's read, is `'not-persisted'`.
6. Unless `publish: false`, await `publisher.publishAll()` inside try/catch. **Nothing rejects after commit.**

**Why no guarded insert is needed.** Versions are contiguous. The pre-check catches stale writers and gaps. A writer that commits after the pre-check holds `expected+1`, so our insert fails on the unique `(stream_id, version)` key. Together this equals `head == expected` at commit, with no read 3.x didn't already do.

**Capabilities** are optional guarantees that conformance tests when claimed. Optional 4.x features, such as a `multiStreamAppend` flag, are added the same way.

**`SnapshotStore`:** Promise-only, `getEnvelope(s)` required, `appendSnapshot` **stays positional**. The base class defaults `getManyLastSnapshotEnvelopes` (loop) and `getLastEnvelopesForAggregate` (throws `UnsupportedOperationException`).

### 2. Publishing pipeline

```ts
export interface EnvelopePublisher {
	publishAll(envelopes: readonly EventEnvelope[]): Promise<void>; // never rejects
}
export interface IEventPublisher {
	publish(envelope: EventEnvelope): void | Promise<void>;
	publishAll?(envelopes: readonly EventEnvelope[]): Promise<void>; // optional batch form
}
export interface EventDeliveryError { kind: 'publisher' | 'subscriber'; handler: string; envelope: EventEnvelope; error: unknown }

@Injectable()
export class EventBus extends ObservableBus<EventEnvelope> implements EnvelopePublisher, BeforeApplicationShutdown, OnApplicationShutdown {
	publishAll(envelopes: readonly EventEnvelope[]): Promise<void>;
	publish(envelope: EventEnvelope): Promise<void>; // was sync void
	whenIdle(options?: { timeout?: number }): Promise<void>;
	readonly deliveryErrors$: Observable<EventDeliveryError>;
}
```

- **Wiring.** The store gets the bus through `EventStoreContext` at construction. The `Proxy`, the `publish` setter and the "appended before bootstrap" warning go away.
- **Publishers** get an append's envelopes in commit order (one call each, or one `publishAll`) and run concurrently under `Promise.allSettled`. Every call races `publisherTimeout` (default 30 s; `0` disables it). Failures and timeouts are logged and emitted on `deliveryErrors$`, and later envelopes still flow. Async publishers are now **awaited** (3.0.1 fired and forgot), for backpressure and deterministic tests.
- **Guarantee.** Delivery is in-process, at-most-once and ordered per publisher. The 4.x outbox adds at-least-once.
- **Subscribers** stay `mergeMap` (parallel) with 3.0.1's isolation; appends don't await them, and their failures also go to `deliveryErrors$`. This keeps `@EventSubscriber({ events, ordering })` additive in 4.x.
- **Shutdown.** `beforeApplicationShutdown` awaits `whenIdle({ timeout: shutdownTimeout })` (default 10 s), then `onApplicationShutdown` unsubscribes. 3.x unsubscribed in `onModuleDestroy`, dropping deliveries in flight.

### 3. Module configuration

```ts
export const { ConfigurableModuleClass, ASYNC_OPTIONS_TYPE } =
	new ConfigurableModuleBuilder<EventSourcingModuleOptions>({ optionsInjectionToken: EVENT_SOURCING_OPTIONS })
		.setClassMethodName('forRoot')
		.setFactoryMethodName('createEventSourcingOptions') // 3.x options factories keep working
		.setExtras({}, (def) => ({ ...def, global: true, imports: [...(def.imports ?? []), DiscoveryModule],
			providers: [...(def.providers ?? []), ...CORE_PROVIDERS], exports: CORE_EXPORTS })) // ONE global module
		.build();

export type EventStoreDriver<TOptions = any> = new (context: EventStoreContext, options: TOptions) => EventStore<TOptions>;
export interface EventStoreConfig { driver: EventStoreDriver; useDefaultPool?: boolean } // driver options stay flat

export interface EventSourcingModuleOptions<TE extends EventStoreConfig = InMemoryEventStoreConfig, TS extends SnapshotStoreConfig = InMemorySnapshotStoreConfig> {
	events?: Type<IEvent>[];
	eventStore?: TE; // default: in-memory
	snapshotStore?: TS;
	defaultEventSerializer?: EventSerializerFactory; // default JsonEventSerializer (§6)
	publishing?: { publisherTimeout?: number; shutdownTimeout?: number };
}

@Module({})
export class EventSourcingModule extends ConfigurableModuleClass {
	static forRoot<TE extends EventStoreConfig, TS extends SnapshotStoreConfig>(options: EventSourcingModuleOptions<TE, TS>): DynamicModule;
	static forRootAsync<TE extends EventStoreConfig, TS extends SnapshotStoreConfig>(options: EventSourcingModuleAsyncOptions<TE, TS>): DynamicModule; // useValue: @deprecated shim
	static forFeature(options: { events?: Type<IEvent>[]; serializers?: Type<IEventSerializer>[]; imports?: ModuleMetadata['imports'] }): DynamicModule;
}
```

**Store providers** inject `[EVENT_SOURCING_OPTIONS, EventMap, EventBus]`. The factory strips `driver` and `useDefaultPool`, calls `new driver({ eventMap, publisher }, options)`, asserts that no template method is overridden (`InvalidEventStoreImplementationException`), then awaits `connect()` and `ensureCollection()`, so a bad connection fails bootstrap. The snapshot store's provider does the same without the context.

**Kept from 3.x:** the flat `{ driver, ...driverOptions }`, the config-typed generics (`forRoot<PostgresEventStoreConfig, …>`), the in-memory default and the `EVENT_SOURCING_OPTIONS` token.

**Registration.** An idempotent `ensureRegistered()` runs in the core `onModuleInit` **and on first use**: `execute`, `EventMap` lookups (and so `appendEvents`) and `publishAll`. NestJS 12 gives global modules distance `Number.MAX_VALUE` (`@nestjs/core` 12.1.1 `injector/container.js:107-109`), so a user `@Global` module ties with ours and may initialise first. During provider instantiation, `ensureRegistered()` throws `EventSourcingNotReadyException` before any I/O.

**Discovery.** `DiscoveryService.getProviders()` finds the providers, and metadata is read from `instance.constructor`, so `useFactory` and `useValue` handlers work. `forFeature` provides an `EventSourcingFeature` instance plus its serializers; Nest 12 keys modules by reference, so each call is distinct. `EventRegistry`, `ExplorerService` and `getOptionsToken` are no longer public.

**Validation.** Bootstrap throws one `EventSourcingConfigurationException { issues[] }` for: an event name shared by two classes; duplicate command/query handlers or event serializers; a serializer or subscriber for an unregistered event; missing decorator metadata; a non-static subscriber, publisher or serializer; class-transformer decorators on an event using the JSON default. Repeated registrations of one class are deduplicated.

**Request scope.** Command and query handlers that aren't statically scoped resolve per call through `moduleRef.resolve(metatype, contextId, { strict: false })`. `execute(message, { request })` registers the request (`ContextIdFactory.getByRequest`), so `@Inject(REQUEST)` works.

### 4. Aggregate API

```ts
export abstract class AggregateRoot {
	get version(): number; // committedVersion + pending
	set version(version: number); // snapshot restore; throws while events are pending
	get committedVersion(): number;
	getUncommittedEvents(): readonly IEvent[]; // copy
	markCommitted(): void; // clears; records the range for SnapshotRepository
	/** @deprecated use getUncommittedEvents() + markCommitted(). Removed in 5.0. */
	commit(): IEvent[];
	applyEvent<T extends IEvent>(event: T, fromHistory?: boolean): void; // handler FIRST, then version++/record
	loadFromHistory(events: AsyncIterable<IEvent[]> | Iterable<IEvent>): Promise<void>; // throws while events are pending
}

@Aggregate({ streamName: 'account', missingHandler: 'throw' }) // or 'ignore'

export class UUID extends Id {
	// also Id, ULID; InstanceType<T> fails on protected constructors
	static generate<T extends typeof UUID>(this: T): T['prototype'];
	static from<T extends typeof UUID>(this: T, id: string): T['prototype'];
}
```

- A throwing handler leaves the aggregate untouched. The `WeakMap` commit tracker moves behind `markCommitted()`.
- `AccountId.generate()` returns an `AccountId`, and ids of different types are never equal. `ValueObject.equals` is null-safe, and ULIDs are validated as Crockford base32.
- `SnapshotRepository.save(id, aggregate, pool?)` keeps its signature but logs snapshot-store failures instead of rejecting.

**No abstract `id` in 4.0.** It would break every subclass, and the 4.x `AggregateRepository<A extends AggregateRoot & { id: Id }>` only needs `committedVersion`, `getUncommittedEvents()`/`markCommitted()` and the options-object `appendEvents`. Its own API (`getById`, `save(aggregate, { pool, metadata })`, `loadFromEnvelopes`) is additive.

### 5. Errors

```ts
export const EventSourcingErrorCode = {
	EventStoreVersionConflict: 'ES_EVENT_STORE_VERSION_CONFLICT',
	EventStorePersistence: 'ES_EVENT_STORE_PERSISTENCE',
	// …one per exported class, pinned by a snapshot test
} as const;

export abstract class EventSourcingError extends Error {
	abstract readonly code: EventSourcingErrorCode;
	constructor(message: string, options?: ErrorOptions); // stack never overwritten
}
export function isEventSourcingError(error: unknown, code?: EventSourcingErrorCode): error is EventSourcingError; // Symbol.for brand

export class EventStoreVersionConflictException extends EventSourcingError {
	override readonly name = 'EventStoreVersionConflictException'; // literal: survives minification
	readonly code = EventSourcingErrorCode.EventStoreVersionConflict;
	readonly streamId: string;
	readonly aggregateId: string;
	readonly pool?: string;
	readonly expectedVersion: ExpectedVersion;
	readonly actualVersion?: number; // unknown after a lost unique-key race
	constructor(details: { stream: EventStream; expectedVersion: ExpectedVersion; actualVersion?: number; pool?: IEventPool }, options?: ErrorOptions);
}
export class EventStorePersistenceException extends EventSourcingError {
	readonly outcome: 'not-persisted' | 'unknown'; // unknown: e.g. connection lost after COMMIT
}
```

- All ~30 exceptions are re-parented and **keep their class names**, so `instanceof` still works. Constructors take one null-safe object argument, and not-found exceptions name the message class.
- *Amended:* `InvalidIdException` is the exception: it keeps `DomainException` as its parent, so 3.x filters that map domain errors to 4xx keep catching invalid ids, and is branded and has a `code`. `EventSourcingError[Symbol.hasInstance]` checks the brand, so `instanceof EventSourcingError` holds for it and for errors from a second copy of the package; subclasses keep the prototype check. Its 3.x `super(message, id)` stays as a `@deprecated` overload.
- *Amended:* `isEventSourcingError(error, code)` narrows to the class of the code through the exported type map `EventSourcingErrorByCode` (an overload; without a code it narrows to `EventSourcingError`), so the fields are reachable without a cast.
- `NotImplementedException` becomes `UnsupportedOperationException`.
- `DomainException` (the user base) gains `name` and `cause` but not `code`, so user subclasses compile.
- After `outcome: 'unknown'`, retrying with a numeric `expectedVersion` is safe, because a duplicate conflicts. With `Any` it is not.

### 6. Serialization default

```ts
export interface EventSerializerFactory { for<E extends IEvent>(event: Type<E>): IEventSerializer<E> }
export class JsonEventSerializer<E extends IEvent = IEvent> implements IEventSerializer<E> {
	static for<E extends IEvent>(event: Type<E>): JsonEventSerializer<E>;
	serialize(event: E): IEventPayload<E>;
	deserialize(payload: IEventPayload<E>): E;
}
// '@ocoda/event-sourcing/class-transformer' (class-transformer ^0.5.1 becomes an optional peer)
export class ClassTransformerEventSerializer<E extends IEvent = IEvent> implements IEventSerializer<E> {
	static for<E extends IEvent>(event: Type<E>): ClassTransformerEventSerializer<E>; // = 3.x DefaultEventSerializer
}
EventSourcingModule.forRoot({ defaultEventSerializer: ClassTransformerEventSerializer }); // explicit opt-in
```

`JsonEventSerializer` reproduces class-transformer 0.5.1 on **undecorated** classes:

- **`serialize`** copies own enumerable keys recursively; nested instances become plain (`ValueObject` stays `{ props: { value } }`). It clones a `Date` and **keeps it a `Date`** (the SQL stores stringify it, Mongo stores BSON, as in 3.x), turns a `Set` into an array and a `Map` into an object, passes `undefined`, `Buffer` and `bigint` through, ignores getters and `toJSON`, and throws `EventSerializationException` on a cycle, before any I/O.
- **`deserialize`** calls `new cls()` with no arguments, so defaults fill fields that old payloads lack. It deep-copies the payload, skipping `__proto__`, `constructor`, getter-only accessors and prototype methods, clones Dates and leaves nested objects plain.

**3.x data.** The stored format and deserialized shapes are unchanged.

**Decorated events cannot switch serializer silently.** At bootstrap, the registrar dynamically imports `class-transformer/cjs/storage.js`. If an event on the JSON default carries `@Type`, `@Transform`, `@Expose` or `@Exclude` metadata, bootstrap fails and names the fix; the library never switches automatically. The check is best-effort (a bundler resolving the `module` build uses a second metadata storage); the M7 cross-version fixture is the real proof.

`DefaultEventSerializer` leaves the root entry, so code that references it must choose a serializer.

### 7. Typed buses

```ts
declare const RESULT: unique symbol;
export abstract class Command<TResult = void> { declare readonly [RESULT]: TResult } // non-optional: not a weak type
export abstract class Query<TResult> { declare readonly [RESULT]: TResult }
export type ResultOf<T> = T extends { readonly [RESULT]: infer R } ? R : any; // plain 3.x classes: any
export type ICommand = object; // was any
export type IQuery = object;

export interface ICommandHandler<C extends ICommand = any, R = ResultOf<C>> { execute(command: C): Promise<R> }
export class CommandBus {
	execute<C extends ICommand, R = ResultOf<C>>(command: C, options?: { request?: unknown }): Promise<R>;
}
export function CommandHandler<C extends ICommand>(command: Type<C>): (target: Type<ICommandHandler<C>>) => void;
// QueryBus/@QueryHandler mirror this; @EventSubscriber and @EventSerializer take classes
```

One generic signature keeps every 3.x call form compiling: `execute(new Open())` infers its result, `execute<AddBookCommand>(cmd)` (the example app) returns `any`, and `execute<OpenAccountCommand, AccountId>(cmd)` (docs, e2e) works unchanged. The proposals' overloads broke the last two.

`execute` becomes async, so a missing handler rejects instead of throwing. Handlers are keyed by class. `declare` emits nothing, so payloads do not change.

### 8. Envelope metadata

```ts
export type EventHeaders = Readonly<Record<string, string | number | boolean | null>>;
export interface AppendMetadata { correlationId?: string; causationId?: string; headers?: EventHeaders }

export interface EventEnvelopeMetadata {
	eventId: EventId;
	aggregateId: string;
	version: number;
	occurredOn: Date;
	correlationId?: string;
	causationId?: string;
	headers?: EventHeaders; // new; absent on 3.x rows
	eventVersion?: number; // M7 schema v2
	globalPosition?: bigint; // §9; set once persisted
}
```

- Metadata applies to every event in the append. Pre-built envelopes keep the fields they already have; options only fill the gaps.
- Validated before any I/O (`InvalidEventMetadataException`): keys non-empty, **`$` keys reserved** for 4.x ALS (`$traceparent`, `$tenant`), values primitive, JSON at most 8 KiB.
- A store without `capabilities.headers` rejects headers with `UnsupportedOperationException` before writing. Headers are never dropped silently.
- `correlationId` and `causationId` already have columns in every 3.x schema, so they ship in 4.0. 4.x ALS fills these same fields, and explicit options win.
- `EventEnvelope.toJSON()` renders bigint as a string (M7).

### 9. Global position and `readAll`

```ts
export interface IReadAllFilter {
	fromPosition?: bigint; // inclusive, like fromVersion; default: the first event
	batch?: number; // default 100
	pool?: IEventPool;
}
```

- **Schema.** The 4.0 migration gives every event table a `global_position` (Mongo: `globalPosition`), unique per pool and backfilled in 3.x's `(event_date, event_id)` order, then drops `event_date` and its index.
- **Contract.** `persistEvents` assigns positions within its all-or-nothing write, and every read returns them. `readAll` yields a pool forward in commit order; an append's events are consecutive. **Gap-safe** means positions strictly increase and, once *p* is yielded, nothing at or below *p* commits later: holes may exist but never fill.
- **Technique.** The reference is a per-pool counter row (Mongo: document) updated in the append's transaction, which serializes appends per pool. Another technique, such as a Postgres identity column read behind a `pg_snapshot_xmin` fence, is fine if the conformance case passes. Mongo without a replica set has no transactions, so it reports `'best-effort'`.
- **Removed, not deprecated:** `getAllEnvelopes`, `IAllEventsFilter`, `EventStore.getYearMonthRange` and `ULID.yearMonth`. A shim would need the dropped column or a full scan, for an order nobody can checkpoint.
- **4.x:** checkpointed subscriptions, projections and the outbox (a checkpointed relay, at-least-once) build on `readAll` plus a stored position, and require `'gap-safe'` unless the user opts out.

## Migration guide

### App users

```ts
// 3.x
const events = account.commit();
await this.eventStore.appendEvents(stream, account.version, events, pool);
// 4.0
const events = account.getUncommittedEvents();
await this.eventStore.appendEvents(stream, events, { expectedVersion: account.committedVersion, pool });
account.markCommitted();
```

- 3.x repositories compile through the shims. Migrate anyway, because `commit()` still loses events when an append fails.
- **Appends.** Saving an unchanged aggregate is a no-op, and gap appends now conflict. Conflict messages changed, so match on `code` and the error fields instead.
- **Publishing.** `eventBus.publish()` returns a Promise, async publishers are awaited, and `store.publish = …` is gone. In tests, `await eventBus.whenIdle()` instead of sleeping.
- **Bootstrap.** Duplicates now fail bootstrap, as do request-scoped subscribers, publishers and serializers. Request-scoped command and query handlers now work. Appending from a provider factory throws.
- **Events with class-transformer decorators** need `defaultEventSerializer: ClassTransformerEventSerializer`.
- **Ids.** `AccountId.generate()` returns an `AccountId`, and ids of different types are no longer equal. For `ULID.yearMonth`, use `id.date.toISOString().slice(0, 7)`.
- **All-events reads.** `getAllEnvelopes({ since, until })` becomes `readAll({ fromPosition })`: store the last `globalPosition` and resume at `checkpoint + 1n`; filter date windows on `occurredOn`. The backfill keeps 3.x's order for existing events.
- **DynamoDB** stays on 3.x. To move, import exported events into a 4.0 store as pre-built envelopes with `publish: false`; they keep their ids and timestamps.

### Custom store authors

1. The constructor becomes `(context, options)`. Drop yours, or forward both arguments.
2. Delete `appendEvents`, `getEvents`, `getEvent` and all use of `EventMap`.
3. Implement `getStreamVersion`, `getEnvelope`, `getEnvelopes`, `readAll` (replacing `getAllEnvelopes`, `getYearMonthRange` and the year-month column) and `persistEvents`. `persistEvents` inserts atomically, with no version checks or serialization, returns the positions it assigned, and maps duplicate keys to `{ status: 'conflict' }`: PG `23505`, MariaDB `1062`, Mongo `11000`.
4. Make every method `async`, snapshot store included.
5. Declare `capabilities`. Persist correlation, causation and `headers`, then set `headers: true`. Claim `'gap-safe'` only if its conformance case passes.
6. For tracing or other decoration, override `persistEvents` and call `super`.
7. Construct exceptions with object arguments. Replace `error.constructor === X` with `isEventSourcingError(error, code)`.
8. Run `describeEventStoreConformance(name, (context) => …)` and `describeSnapshotStoreConformance` from `@ocoda/event-sourcing/testing`. Capabilities replace `skip`, and a skip must give a reason.

## Alternatives considered

- **Unique key alone** (robust): misses gaps. **Guarded insert per driver** (dx): duplicates the base pre-check.
- **Constructor runtime-`final` guard** (robust): misses class-field overrides; we check at bootstrap.
- **Queued fire-and-forget publishing, sequential subscribers** (robust): an append no longer implies publishers ran, one slow handler stalls all aggregates, and it changes the default the plan keeps.
- **Date → ISO, rejecting `Map`/`Set`, `Object.assign` deserialization** (robust, dx): mixed Mongo types, broken 3.x appends, shallow and `__proto__`-unsafe.
- **Unforced breaks:** abstract `id`, removing `commit()`, nested `{ driver, options }`, required `eventStore`, `*Error` renames, string-only headers.
- **`readAll` in 4.x, beside the year-month API:** a second migration. **Plain sequence or `AUTO_INCREMENT` positions:** they commit out of order, so tailing readers skip late commits.

## Consequences

**Positive:** one conformance-tested concurrency contract with self-describing conflicts. Publishing never fails a committed append, and misconfiguration fails at bootstrap. Payloads are unchanged, and class-transformer leaves the runtime. Every built-in store has a checkpointable global order, so subscriptions, projections, ordering, outbox, ALS, `AggregateRepository`, KurrentDB and upcasters (in the base read path) all land additively.

**Negative**

- Custom stores must be rewritten, mostly by deleting code.
- Slow publishers slow commands, up to the timeout.
- Nest 12 runs `onModuleDestroy` before `beforeApplicationShutdown`, so in-flight subscribers can hit torn-down user providers. Call `await eventBus.whenIdle()` before `app.close()`.
- 3.x accepted gap appends. On gapped streams the counted version drifts and saves conflict. M7's `migrate()` dry run must report them; 4.x `loadFromEnvelopes` fixes the version.
- Appends within a pool serialize on its position counter, and the backfill rewrites every event row.

**PR order (M6):** errors → store template + in-memory (with `readAll`) + conformance → publishing → module → aggregate/ids → buses → serializer. Drivers follow in M7, one PR each; `headers` and `global_position` land with the schema v2 migration.

*Amended by D1:* errors → additive store groundwork → store template + in-memory (with `readAll`) + conformance, with an interim path for the drivers, and the Promise-only snapshot contract → one PR per driver that goes native with schema v2 and `migrate()` ([ADR 0002](./0002-schema-v2.md)), in parallel with publishing and buses → a finalize PR that removes the interim path and the year-month API → module → aggregate/ids → serializer.

## Test plan

| Decision | Proof | Kind |
| --- | --- | --- |
| §1 empty | `append-empty-noop`: no SPI call, no publish | conformance |
| §1 versions | `expected-exact`, `expected-stale`, `expected-gap` (expected 5, actual 3 → `actualVersion: 3`, nothing written), `no-stream-on-existing`, `conflict-fields` | conformance |
| §1 races | `conflict-concurrent-appends` (8 exact writers, one wins); `concurrent-any` (8 × 2 events, versions 1–16) | conformance |
| §1 shims | `append-envelope-contiguity`, `append-deprecated-positional`, `append-atomic-partial-failure` (gated on `atomicAppend`) | conformance |
| §1 template | `template-not-overridden` (the template methods are the base class's); an override fails bootstrap | conformance |
| §2 publishing | A publisher that throws, rejects or hangs: the append resolves, others still receive, `deliveryErrors$` emits, order holds. A conflict publishes nothing. `app.close()` drains, then disconnects once | unit, bootstrap |
| §3 module | Every `forRoot` and `forRootAsync` variant; two `forFeature` modules; two apps in one process; each validation issue; a bad connection | Nest 12 bootstrap |
| §3 registration | Appends from a user `@Global` `onModuleInit` and from a depth-4 module are delivered; a factory append throws `NotReady`; request-scoped handlers get a fresh instance and `REQUEST` | Nest 12 bootstrap |
| §4 aggregate | No drift after a throwing handler; retry after a failed append; `missingHandler: 'ignore'`; the 9 → 11 snapshot boundary; `AccountId.generate()` type; ids of different types unequal; bad ULIDs rejected | unit, type |
| §5 errors | Table over every export: literal `name`, unique `code`, `cause`, `stack`, `new X(undefined)` | unit |
| §6 serializer | Differential corpus against class-transformer 0.5.1 (Date, Map, Set, `ValueObject`, `__proto__`), `toStrictEqual` including the prototype; tripwire fires; M7 fixture (3.0.2 writes, v4 reads and appends; see ADR 0002) | unit, M7 |
| §7 buses | `expectTypeOf` for inference and both 3.x generic forms; a missing handler rejects | type, unit |
| §8 metadata | `metadata-round-trip`, `headers-round-trip`, `headers-unsupported-rejects`; reserved keys and the size cap rejected with no SPI call | conformance |
| §9 `readAll` | `read-all-order` (commit order; appended, published and read positions match), `read-all-resume` (inclusive `fromPosition`, every `batch`, per pool), `read-all-gap-safe` (8 appenders, a tailing reader reads each event once; gated); the backfill keeps 3.x's order (D6) | conformance, M7 |

## Open questions

1. **Keep the 3.x shims (positional `appendEvents`, `commit()`, `forRootAsync({ useValue })`) until 5.0?** *Recommended: yes*, since they make the upgrade incremental.
2. **Default `publisherTimeout`?** *Recommended: 30 s, with `0` to disable it*, because adding a default later changes behaviour.
3. ~~**Return `EventEnvelope[]` or an `AppendResult`?**~~ *Resolved by the amendment: `EventEnvelope[]`*, since every envelope now carries its position.
4. ~~**Fail bootstrap on an overridden template method, or only conformance?**~~ *Resolved by amendment D8: fail bootstrap.* A bypass silently skips the conflict checks and publishing.
5. **Warn about an implicit in-memory store in production?** *Recommended: keep `eventStore` optional, but warn when `NODE_ENV === 'production'`.*
6. ~~**MongoDB without a replica set: `'best-effort'` or refuse to connect?**~~ *Resolved by amendment D16: `'best-effort'`*, like `atomicAppend: false`, with a one-time warning.

## Amendments (store contract)

*2026-09-29, pending owner confirmation, non-blocking.* Implementing §1, §8 and §9 raised the questions below. Where an amendment changes the text above, the amendment wins. The schema, the position technique and `migrate()` are in [ADR 0002](./0002-schema-v2.md).

1. **D1, intermediate states.** The template lands with an interim legacy path. A driver that still overrides `appendEvents` is wrapped by the 3.x `Proxy`, which publishes through `context.publisher`, and interim SPI methods that throw, plus a deprecated `eventMap` accessor, keep it compiling. Each driver then goes native together with schema v2 and `migrate()`, in one PR, and a finalize PR deletes the interim path. `getAllEnvelopes`, `IAllEventsFilter`, `getYearMonthRange` and `ULID.yearMonth` are gone before any GA, so "removed, not deprecated" holds for 4.0.0. No `'none'` capability comes back.
2. **D2, `Any` retries.** Up to **16 attempts** (was 3 retries), with a jittered backoff of `random(0, min(100, 2 ** attempt))` ms, keeping the event ids and `occurredOn` and renumbering the versions. A writer loses at most once per competing commit, so 16 attempts cover 16 concurrent writers per stream.
3. **D3, outcomes.** `'unknown'` only when a `COMMIT` was sent and no answer came back, when MongoDB's commit result stays unknown after retries, or when the MongoDB standalone compensation fails. Every earlier failure is `'not-persisted'`: the driver throws it for encoding errors and for anything before `COMMIT` is sent, and the template throws it when the pre-check read fails. The template turns any other foreign error into `'unknown'`, as step 5 says. `PersistOutcome` stays two-armed. See [Outcome classification](#outcome-classification-d3).
4. **D4, unknown pools.** The catalog row is authoritative. An append to a pool whose collection was never ensured is `'not-persisted'` with cause `EventCollectionNotFoundException`, and creates nothing. The reads of every event store throw `EventCollectionNotFoundException`. Snapshot stores keep their 3.x behaviour.
5. **D5, bigint.** Positions are `bigint`. The SQL stores read them as text, and one shared `toPosition()` converts driver values. `EventEnvelope.toJSON()` renders them as strings, and the conformance messages use a bigint-safe `stringify`. A bigint in a payload is `'not-persisted'` on the SQL stores (documented) and an Int64 on MongoDB. Specs cover `bigIntAsNumber: true` (MariaDB) and `useBigInt64: true` (MongoDB).
6. **D6, position semantics.** Per pool, starting at `1n`. `fromPosition` is inclusive, and `0n` or omitted means the start. An append's positions are consecutive and never reused, and the counter never decreases: after the backfill it equals the highest position. The backfill order is `(event_date, event_id, stream_id, version)`. After a commit the template checks the returned positions and **logs** a mismatch; it never throws.
7. **D7, publisher sequencing.** A minimal, fire-and-forget `EventBus.publishAll` lands first. The template PR passes the bus as `context.publisher` and removes the `publish` setter. The publishing PR adds awaiting, timeouts, `deliveryErrors$` and `whenIdle`. `connect` and `ensureCollection` stay in `onModuleInit` until the module PR.
8. **D8, template guard.** A store overrides the template when `appendEvents`, `getEvent` or `getEvents` is an own property of the instance, or of any prototype between it and `EventStore.prototype`. Overriding `persistEvents` is allowed. The provider enforces the guard for native stores from the template PR and for every store from the finalize PR, which answers [open question 4](#open-questions). The conformance case `template-not-overridden` checks it too.
9. **D9, capabilities.** A mutable object, final once `connect()` resolves: built-in stores redeclare the field, and MongoDB `Object.assign`s the result of its topology check. The defaults (`resolveCapabilities`) are `{ atomicAppend: true, headers: false, globalOrder: 'best-effort' }`. Conformance reads the capabilities after the factory resolves.
10. **D10, name collision.** `EventStoreDriver` and `SnapshotStoreDriver` become the constructor types of §3, and the 3.x instance interfaces with those names are removed. The e2e generics constrain on the config types.
11. **D11, conformance distribution.** The suites stay in the private `@ocoda/event-sourcing-testing` package until the `@ocoda/event-sourcing/testing` subpath lands (M8). Until then the docs say "coming".
12. **D12, pre-built envelopes.** They may be mixed with raw events if the whole array is contiguous from `expected + 1`, and they need a numeric expected version. They keep their id, `occurredOn`, correlation, causation, headers and `eventVersion`; the options fill absent fields only, and `headers` counts as one field. `$` header keys are allowed on pre-built envelopes only. An incoming `globalPosition` is ignored, and inputs are never mutated. Each store instance has one monotonic id factory. The groundwork PR fixes `EventEnvelope.create()` so that `eventId: undefined` no longer replaces the generated id.
13. **D13, new exceptions.** `InvalidEventEnvelopeException`, `InvalidEventMetadataException`, `InvalidAppendOptionsException` (an invalid or negative expected version, also from the positional shim, or an invalid pool), `InvalidEventStoreImplementationException`, `EventStoreSchemaException` and `EventCollectionNotFoundException`, each with its code. `EventSourcingNotReadyException`, `EventSourcingConfigurationException` and `EventSerializationException` land with the PRs that throw them.
14. **D14, limits.** Stream ids, aggregate ids, event names, correlation ids and causation ids are at most 255 characters, and headers at most 8 KiB of JSON, all validated before any I/O. The schema v2 columns are sized to match, and `ensureCollection` rejects table names that the database would truncate.
15. **D15, snapshot store.** Promise-only; its getters are not templates. `getEnvelope(s)` are required, the base defaults are those of §1, and `NotImplementedException` has become `UnsupportedOperationException`. The `loadAll` cursor is **exclusive, descending and in binary order** in every store. A unique (partial) index plus a per-stream lock or transaction enforces one latest flag per stream; a duplicate is a snapshot conflict, and `migrate()` repairs streams with no flag or several. `getLastEnvelope` reads the highest version. The snapshot store's `disconnect` at shutdown comes with the module PR.
16. **D16, MongoDB topology.** Detected with `hello`. A replica set is `{ atomicAppend: true, globalOrder: 'gap-safe' }`; `mongos` is atomic but `'best-effort'`; a standalone server is `{ atomicAppend: false, globalOrder: 'best-effort' }`, with a one-time warning, which answers [open question 6](#open-questions). CI runs a standalone server and a replica set in the same job. There is no `transactions` option in 4.0; one can be added later.
17. **D17, counter and listing.** One catalog, `event_sourcing_collections`, per schema or database, keyed by collection, instead of a counter table per pool. Conformance and driver cleanup delete their rows. `listCollections` reads the catalog, so v1 tables are no longer listed (documented).
18. **D18, MariaDB technique.** `UPDATE … SET last_position = LAST_INSERT_ID(last_position + n)` inside the insert transaction, then the result's `insertId`; the version pre-check stays outside. MariaDB claims `'gap-safe'` only with stress, source and CI evidence, and Galera clusters are `'best-effort'`.
19. **D19, PostgreSQL technique.** The counter row, under an explicit `READ COMMITTED`, with `unnest` inserts. No `xid8` column in 4.0; one can be added later without a rewrite.
20. **D20, migration and detection.** `migrate()` lives in the drivers, as a static method (no bootstrap needed) and on a connected instance, with shared types in core. A `ddl: 'auto' | 'none'` option. Bootstrap never migrates: a v1 event table fails it with `EventStoreSchemaException`, while a v1 snapshot table warns and keeps working. `migrate()` discovers collections by their shape.
21. **D21, positional shim.** Detected by `typeof args[1] === 'number'`; the expected version is `aggregateVersion − events.length`. Documented behaviour changes: an empty append returns `[]`, a gap conflicts, and non-contiguous pre-built envelopes throw `InvalidEventEnvelopeException`. It emits a one-time `DeprecationWarning` with the code `OCODA_ES_POSITIONAL_APPEND`.
22. **D22, bootstrap connection failures.** PostgreSQL already fails fast. MariaDB's `connect()` probes with `SELECT @@wsrep_on`, and MongoDB's `connect()` runs `hello` (`serverSelectionTimeoutMS` is documented). In every driver, `disconnect()` is idempotent and a no-op before `connect()`. The module PR moves `connect` and `ensureCollection` into the provider factory and keeps honouring `useDefaultPool: false`.
23. **D23, CI matrix.** Add PostgreSQL 18 and MariaDB 11.8. PostgreSQL 13 and MongoDB 6 stay; dropping them is an owner call and not needed for 4.0.
24. **D24, time zones.** MariaDB v2 stores UTC wall time through explicit strings. The MariaDB migration runs with the session time zone `+00:00` and restores `occurred_on` from the ULID when the difference is a whole number of quarter hours within ±14 hours (`repairOccurredOn`, default true). PostgreSQL snapshots convert with `legacyTimeZone`, which defaults to the process time zone and is reported by the dry run. The `registered_on` of superseded MariaDB snapshots that 3.x overwrote is reported, not repaired.
25. **D25, MariaDB collation.** v2 tables use `utf8mb4_bin`, so stream ids are case-sensitive, as on PostgreSQL and MongoDB. The dry run counts the streams that split. This is owner decision 1 in ADR 0002.
26. **D26, `eventVersion`.** A nullable `INT` column (MongoDB: an optional field), written only from pre-built envelopes in 4.0 and reserved for 4.x upcasters.
27. **D27, headers storage.** One `headers` column: PostgreSQL `JSONB`, MariaDB `JSON`, a MongoDB subdocument. Absent headers read back as `undefined`. Every built-in store claims `headers: true` once it runs schema v2.
28. **D28, `toJSON`.** `EventEnvelope.toJSON()` ships with the groundwork PR, not with M7 as §8 says.
29. **D29, id validation on read.** Stores rebuild ids with a non-validating `EventId.fromTrusted()`, so the ids PR can tighten `from()` to Crockford base32 without breaking 3.x rows. The migration's dry run counts non-Crockford ids.
30. **D30, online migration.** 4.0 guarantees an offline migration only. An online "prepare" phase can be added in a minor release.
31. **D31, MongoDB read concern.** `readAll` uses majority read concern on replica sets and `mongos`, so a failover can't hand out a position that was already yielded. Appends write with `w: 'majority'`.
32. **D32, option stripping.** The provider strips `driver` and `useDefaultPool`, and each driver strips `ddl` before it creates its client.

### Outcome classification (D3)

`persistEvents` returns `{ status: 'conflict', cause }` **only** for a duplicate on the `(stream, version)` key. Every other failure is either a thrown `EventStorePersistenceException` with a known outcome, or a foreign error, which the template turns into `'unknown'`.

| Failure | PostgreSQL / MariaDB | MongoDB replica set | MongoDB standalone | In-memory |
| --- | --- | --- | --- | --- |
| Encoding the payload or headers fails before any I/O (a bigint or a cycle in `JSON.stringify`) | throw `not-persisted` (encode before `BEGIN`) | n/a (BSON) | n/a | n/a |
| Acquiring a connection fails, or any error before `COMMIT` is sent (including PostgreSQL 40P01, 55P03, 57014, 40001, 22001, 22P05, 42P01, 42703 and MariaDB 1213, 1205, 1146, 1406, 1644) | `ROLLBACK` (best effort), throw `not-persisted` | abort, throw `not-persisted` | see the compensation row | throw `not-persisted` |
| The catalog row is missing (the pool was never ensured, or not migrated) | `ROLLBACK`, `not-persisted`, `cause: EventCollectionNotFoundException` | same | same (no reservation made) | same |
| Duplicate `(stream_id, version)` (PostgreSQL: `error.constraint` is the cached primary key name; MariaDB: key `PRIMARY`; MongoDB: `keyPattern { streamId, version }`) | `{ status: 'conflict', cause }` | same | a conflict if the compensating delete succeeded, else throw `unknown` | conflict |
| Duplicate `_id` / `event_id` | n/a (no unique key on the SQL `event_id`) | re-read the head: head ≥ first version is a conflict, else `not-persisted` ("duplicate event id") | same, after the compensation | n/a |
| Duplicate `global_position` (counter drift) | `not-persisted`, and `logger.error` says that `ensureCollection()` heals the counter | same | same | n/a |
| MongoDB `TransientTransactionError` | n/a | retry inside `persistEvents` (ADR 0002 §4) | n/a | n/a |
| `COMMIT` sent and no answer (connection lost), or `UnknownTransactionCommitResult` after retries | throw `unknown` | throw `unknown` | n/a | n/a |
| The standalone compensating delete fails | n/a | n/a | throw `unknown` | n/a |
