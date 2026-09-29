# ADR 0001: v4 core API

- **Status:** Proposed
- **Date:** 2026-09-29
- **Scope:** plan milestone M6 (b–f), plus the store hooks that M7 (schema v2) builds on
- **Baseline:** `origin/v4/platform-esm` (#543), which already includes the 3.0.1 fixes

## Context

4.0 (NestJS ^12, ESM-only, one schema migration) is the only release allowed to break things. Read-side features, AsyncLocalStorage (ALS) context and `AggregateRepository` ship in 4.x minors, so 4.0 must keep them additive.

3.x defects that need breaking changes:

- **Concurrency:** drivers get the post-change version and check only `aggregateVersion <= current`. Gaps pass, and unchanged saves throw.
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
	maxEventsPerAppend?: number; // Infinity (DynamoDB: 100)
	headers?: boolean; // false
	globalOrder?: 'gap-safe' | 'best-effort' | 'none'; // 'none'
}

export interface EventStoreContext {
	readonly eventMap: EventMap;
	readonly publisher: EnvelopePublisher; // 4.x may add optional clock/metadata
}

export type PersistOutcome = { status: 'committed' } | { status: 'conflict'; actualVersion?: number; cause?: unknown };

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
	abstract ensureCollection(pool?: IEventPool): Promise<IEventCollection>; // listCollections unchanged
	abstract getStreamVersion(stream: EventStream, pool?: IEventPool): Promise<number>; // 0 when absent
	abstract getEnvelope(stream: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope>;
	abstract getEnvelopes(stream: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]>;
	abstract getAllEnvelopes(filter: IAllEventsFilter): AsyncGenerator<EventEnvelope[]>;
	/** All or nothing; never overwrites; a taken (stream, version) returns a conflict. */
	protected abstract persistEvents(
		envelopes: readonly EventEnvelope[],
		target: { stream: EventStream; collection: IEventCollection; expectedVersion: number; pool?: IEventPool },
	): Promise<PersistOutcome>;
}
```

**`appendEvents` template:**

1. Normalise the deprecated form. Return `[]` for an empty append, with no I/O and no publish.
2. Validate before any I/O:
   - `expectedVersion`;
   - the metadata (§8);
   - `maxEventsPerAppend` (`AppendTooLargeException`);
   - pre-built envelopes, which need a numeric expected version, the stream's `aggregateId` and versions `expected+1…` (`InvalidEventEnvelopeException`). They keep their `eventId` and `occurredOn`, which conformance seeding relies on.
3. Serialize through `EventMap`, using one monotonic id factory.
4. Resolve the expected version:
   - A number (0 is `NoStream`) is **pre-checked** against `getStreamVersion()`. A mismatch throws a conflict carrying `actualVersion`, and nothing is written.
   - `Any` uses that read as the expected version.
5. Call `persistEvents`:
   - A conflict under `Any` retries from step 4, up to 3 times, with the same ids.
   - Any other conflict throws `EventStoreVersionConflictException`.
   - A foreign error becomes `EventStorePersistenceException({ outcome: 'unknown', cause })`.
6. Unless `publish: false`, await `publisher.publishAll()` inside try/catch. **Nothing rejects after commit.**

**Why no guarded insert is needed.** Versions are contiguous. The pre-check catches stale writers and gaps. A writer that commits after the pre-check already holds `expected+1`, so our insert then fails on the unique `(stream_id, version)` key; on DynamoDB, `attribute_not_exists` fails the same way. Together this equals `head == expected` at commit, and it costs no read that 3.x didn't already do.

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
- **Publishers:**
  - Each publisher receives an append's envelopes in commit order, one call per envelope or a single `publishAll`.
  - Publishers run concurrently under `Promise.allSettled`.
  - Every call races `publisherTimeout` (default 30 s; `0` disables it).
  - Failures and timeouts are logged and emitted on `deliveryErrors$`, and later envelopes still flow.
  - Async publishers are now **awaited**; in 3.0.1 they were fire-and-forget. This gives backpressure and a deterministic point for tests.
- **Guarantee.** Delivery is in-process, at-most-once and ordered per publisher. The 4.x outbox adds at-least-once.
- **Subscribers.** The default stays `mergeMap` (parallel) with 3.0.1's isolation, and appends don't await subscribers. Subscriber failures also go to `deliveryErrors$`. Keeping it makes `@EventSubscriber({ events, ordering })` additive in 4.x.
- **Shutdown.**
  - `beforeApplicationShutdown` awaits `whenIdle({ timeout: shutdownTimeout })` (default 10 s).
  - `onApplicationShutdown` unsubscribes. 3.x did this in `onModuleDestroy`, which dropped deliveries still in flight.

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

**Store providers.** Each store provider injects `[EVENT_SOURCING_OPTIONS, EventMap, EventBus]`. Its factory:

1. strips `driver` and `useDefaultPool` from the config;
2. calls `new driver({ eventMap, publisher }, options)`;
3. asserts that no template method is overridden (`InvalidEventStoreImplementationException`);
4. awaits `connect()`, then `ensureCollection()`, so a bad connection fails bootstrap.

The snapshot store's provider works the same way, without the context.

**Kept from 3.x:** the flat `{ driver, ...driverOptions }`, the config-typed generics (`forRoot<PostgresEventStoreConfig, …>`), the in-memory default and the `EVENT_SOURCING_OPTIONS` token.

**Registration.** An idempotent `ensureRegistered()` runs in the core `onModuleInit` **and on first use**. First use means `execute`, `EventMap` lookups (and so `appendEvents`), and `publishAll`.

- **Why first use too.** NestJS 12 gives global modules distance `Number.MAX_VALUE` (`@nestjs/core` 12.1.1 `injector/container.js:107-109`). A user `@Global` module therefore ties with ours and may initialise first.
- **During provider instantiation**, `ensureRegistered()` throws `EventSourcingNotReadyException` before any I/O.

**Discovery.**

- `DiscoveryService.getProviders()` finds the providers.
- Metadata is read from `instance.constructor`, which makes `useFactory` and `useValue` handlers work.
- `forFeature` provides an `EventSourcingFeature` instance plus its serializers. Nest 12 keys modules by reference, so each call is distinct.
- `EventRegistry`, `ExplorerService` and `getOptionsToken` are no longer public.

**Validation.** Bootstrap throws one `EventSourcingConfigurationException { issues[] }` for any of these:

- an event name shared by two classes;
- duplicate command/query handlers or event serializers;
- a serializer or subscriber for an unregistered event;
- missing decorator metadata;
- a non-static subscriber, publisher or serializer;
- class-transformer decorators on an event that uses the JSON default.

Repeated registrations of the same class are deduplicated.

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

- A throwing handler leaves the aggregate untouched.
- `AccountId.generate()` returns an `AccountId`, and ids of different types are never equal. `ValueObject.equals` is null-safe.
- ULIDs are validated as Crockford base32.
- The `WeakMap` commit tracker moves behind `markCommitted()`.
- `SnapshotRepository.save(id, aggregate, pool?)` keeps its signature. It logs snapshot-store failures instead of rejecting.

**No abstract `id` in 4.0.** Adding an abstract `id` would break every subclass, and the 4.x `AggregateRepository<A extends AggregateRoot & { id: Id }>` doesn't need it. It only needs `committedVersion`, `getUncommittedEvents()`/`markCommitted()` and the options-object `appendEvents`, and its own API (`getById`, `save(aggregate, { pool, metadata })`, `loadFromEnvelopes`) is additive.

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

- All ~30 exceptions are re-parented and **keep their class names**, so `instanceof` still works.
- Constructors take one null-safe object argument.
- The not-found exceptions name the message class.
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

- **`serialize`:**
  - copies own enumerable keys recursively; nested instances become plain (`ValueObject` stays `{ props: { value } }`);
  - clones a `Date` and **keeps it a `Date`** (SQL and DynamoDB stringify it, Mongo stores BSON, as in 3.x);
  - turns a `Set` into an array and a `Map` into an object;
  - passes `undefined`, `Buffer` and `bigint` through and ignores getters and `toJSON`;
  - throws `EventSerializationException` on a cycle, before any I/O.
- **`deserialize`:**
  - calls `new cls()` with no arguments, so defaults fill fields that old payloads lack;
  - deep-copies the payload, skipping `__proto__`, `constructor`, getter-only accessors and prototype methods;
  - clones Dates and leaves nested objects plain.

**3.x data.** The stored format and deserialized shapes are unchanged.

**Decorated events cannot switch serializer silently.**

- At bootstrap, the registrar dynamically imports `class-transformer/cjs/storage.js`.
- If an event on the JSON default carries `@Type`, `@Transform`, `@Expose` or `@Exclude` metadata, bootstrap fails and names the fix.
- The library never switches serializer automatically.

The check is best-effort: a bundler resolving the `module` build uses a second metadata storage. The M7 cross-version fixture is the real proof.

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

We use one generic signature instead of overloads, so every 3.x call form still compiles:

- `execute(new Open())` infers its result type.
- `execute<AddBookCommand>(cmd)` (the example app) returns `any`.
- `execute<OpenAccountCommand, AccountId>(cmd)` (docs, e2e) works unchanged.

The overloads in the proposals broke the last two forms.

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
	globalPosition?: bigint; // M7, when globalOrder !== 'none'
}
```

- Metadata applies to every event in the append. Pre-built envelopes keep the fields they already have; options only fill the gaps.
- Validated before any I/O (`InvalidEventMetadataException`):
  - keys must be non-empty;
  - **`$` keys are reserved** for 4.x ALS (`$traceparent`, `$tenant`);
  - values must be primitives;
  - the JSON must be at most 8 KiB.
- A store without `capabilities.headers` rejects headers with `UnsupportedOperationException` before writing. Headers are never dropped silently.
- `correlationId` and `causationId` already have columns in all four 3.x schemas, so they ship in 4.0.
- 4.x ALS fills these same fields, and explicit options win.
- `EventEnvelope.toJSON()` renders bigint as a string (M7).

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
- **Ids.** `AccountId.generate()` returns an `AccountId`, and ids of different types are no longer equal.

### Custom store authors

1. The constructor becomes `(context, options)`. Drop yours, or forward both arguments.
2. Delete `appendEvents`, `getEvents`, `getEvent` and all use of `EventMap`.
3. Implement `getStreamVersion`, `getEnvelope`, `getEnvelopes` and `persistEvents`. `persistEvents` inserts atomically, with no version checks or serialization, and maps duplicate keys to `{ status: 'conflict' }`: PG `23505`, MariaDB `1062`, Mongo `11000`, DynamoDB `ConditionalCheckFailed`/`TransactionConflict`.
4. Make every method `async`, snapshot store included.
5. Declare `capabilities`. Persist correlation, causation and `headers`, then set `headers: true`.
6. For tracing or other decoration, override `persistEvents` and call `super`.
7. Construct exceptions with object arguments. Replace `error.constructor === X` with `isEventSourcingError(error, code)`.
8. Run `describeEventStoreConformance(name, (context) => …)` and `describeSnapshotStoreConformance` from `@ocoda/event-sourcing/testing`. Capabilities replace `skip`, and a skip must give a reason.

## Alternatives considered

- **Unique key alone** (robust): misses gaps. **Guarded insert per driver** (dx): duplicates the base pre-check.
- **Constructor runtime-`final` guard** (robust): misses class-field overrides; we check at bootstrap.
- **Queued fire-and-forget publishing, sequential subscribers** (robust): an append no longer implies publishers ran, one slow handler stalls all aggregates, and it changes the default the plan keeps.
- **Date → ISO, rejecting `Map`/`Set`, `Object.assign` deserialization** (robust, dx): mixed Mongo types, broken 3.x appends, shallow and `__proto__`-unsafe.
- **Unforced breaks:** abstract `id`, removing `commit()`, nested `{ driver, options }`, required `eventStore`, `*Error` renames, string-only headers.

## Consequences

**Positive:** one conformance-tested concurrency contract with self-describing conflicts. Publishing never fails a committed append, and misconfiguration fails at bootstrap. Payloads are unchanged, and class-transformer leaves the runtime. Ordering, outbox, ALS, `AggregateRepository`, `readAll`, KurrentDB and upcasters (in the base read path) all land additively.

**Negative**

- Custom stores must be rewritten, mostly by deleting code.
- Slow publishers slow commands, up to the timeout.
- Nest 12 runs `onModuleDestroy` before `beforeApplicationShutdown`, so in-flight subscribers can hit torn-down user providers. Call `await eventBus.whenIdle()` before `app.close()`.
- 3.x accepted gap appends. On gapped streams the counted version drifts and saves conflict. M7's `migrate()` dry run must report them; 4.x `loadFromEnvelopes` fixes the version.

**PR order (M6):** errors → store template + in-memory + conformance → publishing → module → aggregate/ids → buses → serializer. Drivers follow in M7, one PR each; `headers` lands with the schema v2 column.

## Test plan

| Decision | Proof | Kind |
| --- | --- | --- |
| §1 empty | `append-empty-noop`: no SPI call, no publish | conformance |
| §1 versions | `expected-exact`, `expected-stale`, `expected-gap` (expected 5, actual 3 → `actualVersion: 3`, nothing written), `no-stream-on-existing`, `conflict-fields` | conformance |
| §1 races | `conflict-concurrent-appends` (8 exact writers, one wins); `concurrent-any` (8 × 2 events, versions 1–16) | conformance |
| §1 limits, shims | `append-too-large`, `append-envelope-contiguity`, `append-deprecated-positional`, `append-atomic-partial-failure` (capability-gated) | conformance |
| §1 template | `template-not-overridden` (`store.appendEvents === EventStore.prototype.appendEvents`, same for `getEvent(s)`); an override fails bootstrap | conformance |
| §2 publishing | A publisher that throws, rejects or hangs: the append resolves, others still receive, `deliveryErrors$` emits, order holds. A conflict publishes nothing. `app.close()` drains, then disconnects once | unit, bootstrap |
| §3 module | Every `forRoot` and `forRootAsync` variant; two `forFeature` modules; two apps in one process; each validation issue; a bad connection | Nest 12 bootstrap |
| §3 registration | Appends from a user `@Global` `onModuleInit` and from a depth-4 module are delivered; a factory append throws `NotReady`; request-scoped handlers get a fresh instance and `REQUEST` | Nest 12 bootstrap |
| §4 aggregate | No drift after a throwing handler; retry after a failed append; `missingHandler: 'ignore'`; the 9 → 11 snapshot boundary; `AccountId.generate()` type; ids of different types unequal; bad ULIDs rejected | unit, type |
| §5 errors | Table over every export: literal `name`, unique `code`, `cause`, `stack`, `new X(undefined)` | unit |
| §6 serializer | Differential corpus against class-transformer 0.5.1 (Date, Map, Set, `ValueObject`, `__proto__`), `toStrictEqual` including the prototype; tripwire fires; M7 fixture (3.0.1 writes, v4 reads and appends) | unit, M7 |
| §7 buses | `expectTypeOf` for inference and both 3.x generic forms; a missing handler rejects | type, unit |
| §8 metadata | `metadata-round-trip`, `headers-round-trip`, `headers-unsupported-rejects`; reserved keys and the size cap rejected with no SPI call | conformance |

## Open questions

1. **Keep the 3.x shims (positional `appendEvents`, `commit()`, `forRootAsync({ useValue })`) until 5.0?** *Recommended: yes*, since they make the upgrade incremental.
2. **Default `publisherTimeout`?** *Recommended: 30 s, with `0` to disable it*, because adding a default later changes behaviour.
3. **Return `EventEnvelope[]` or an `AppendResult`?** *Recommended: `EventEnvelope[]`*, since versions and positions ride on the envelope metadata.
4. **Fail bootstrap on an overridden template method, or only conformance?** *Recommended: fail bootstrap.* A bypass silently skips the conflict checks and publishing.
5. **Warn about an implicit in-memory store in production?** *Recommended: keep `eventStore` optional, but warn when `NODE_ENV === 'production'`.*
