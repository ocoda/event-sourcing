# @ocoda/event-sourcing

## 4.0.0-next.2

### Major Changes

- [#589](https://github.com/ocoda/event-sourcing/pull/589) [`c62d7ce`](https://github.com/ocoda/event-sourcing/commit/c62d7ce1f93007b73437888c42c32d5b1a6547e3) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **`JSON.stringify(envelope)` writes the event id as a string.** `EventEnvelope.toJSON()` renders `metadata.eventId` as its value, such as `"01JA50F56AM0CCDBNVQW3TTWNY"`, where 3.x wrote the value object as `{ "props": { "value": "01JA50F56AM0CCDBNVQW3TTWNY" } }`. A publisher or an API that sends envelopes as JSON now sends the id itself: a consumer that read `metadata.eventId.props.value` reads `metadata.eventId`, and `EventId.from(json.metadata.eventId)` turns it back into an `EventId`. The rest of the metadata is written as before, with `occurredOn` as an ISO 8601 string; the new global position is a decimal string.
  
  What the stores write doesn't change. Value objects get no `toJSON`, so `JSON.stringify(id)` still writes `{ props: { value } }`, and so do the PostgreSQL and MariaDB stores for a value object in a snapshot or in the payload of a custom serializer. The payload in the JSON of an envelope is rendered the same way, as it is stored.

- [#592](https://github.com/ocoda/event-sourcing/pull/592) [`6443fae`](https://github.com/ocoda/event-sourcing/commit/6443fae132e584776fa75cda6e9d3a8798647da8) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **Event handlers can apply events, and `markCommitted(events)` marks only the events that were appended.** This settles the aggregate questions that the 4.0 aggregate API left open. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#aggregates-and-ids) and [Event handlers that apply events](https://ocoda.github.io/event-sourcing/start/aggregates#event-handlers-that-apply-events).
  
  - **An event that an `@EventHandler()` applies is applied once that handler returns**, right after the handler's own event. The events keep the order and the versions that 3.x recorded: an event that a handler applies follows the handler's event, and the events that its own handler applies follow it. What changes is when its handler runs: 3.x ran it in the middle of the handler that applied the event.
  - **While an aggregate is loaded from its events, the `applyEvent()` calls of its handlers are ignored**, because the stored events already include the events they applied. 3.x applied such an event a second time on every load, counted it twice and recorded it as uncommitted, so the next save stored it again. Streams that 3.x wrote this way now load as they were written.
  - **When an event handler throws, the events it applied are dropped.** The events whose handlers returned stay applied.
  - **`markCommitted(events)`** marks the events that `getUncommittedEvents()` returned as committed, once they are appended, and keeps the events applied in the meantime, for example while the append ran, for the next save. Events that aren't the first uncommitted events, in order, throw an `UncommittedEventsException` with `operation: 'markCommitted'`, and the aggregate stays unchanged. `markCommitted()` without arguments still marks every uncommitted event as committed, also one that was applied while the append ran and was never stored.
  
  **Migration**
  
  1. Pass the appended events to `markCommitted()`:
  
     ```ts
     const events = account.getUncommittedEvents();
     await this.eventStore.appendEvents(stream, events, { expectedVersion: account.committedVersion, pool });
     account.markCommitted(events);
     ```
  
  2. Where an event handler applies an event and then reads state that the handler of that event changes, move that code into the handler of the applied event: it now runs after the handler that applied the event, as it does when the aggregate is loaded.

- [#577](https://github.com/ocoda/event-sourcing/pull/577) [`7f1e82c`](https://github.com/ocoda/event-sourcing/commit/7f1e82cb91dff9eb458cfcca8600889e865ba52d) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **Aggregates keep their events until they are stored, and ids keep their class.** This is the aggregate API of ADR 0001 §4. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#aggregates-and-ids).
  
  - **`AggregateRoot` gets `committedVersion`, `getUncommittedEvents()` and `markCommitted()`.** `version` is `committedVersion` plus the number of uncommitted events. A repository appends `getUncommittedEvents()` with `expectedVersion: committedVersion`, then calls `markCommitted()`, so a failed append keeps the events and the save can be retried. Saving an unchanged aggregate appends nothing.
  - **`commit()` is deprecated** and will be removed in 5.0. It still returns the events and marks them as committed, but it does so before they are appended, so they are lost when the append fails.
  - **`applyEvent()` runs the event handler first**, then counts the event. A handler that throws now leaves the version and the uncommitted events unchanged; 3.x had already counted and recorded the event. A handler that reads `this.version` gets the version before its event, one less than in 3.x.
  - **`loadFromHistory()`, `applyEvent(event, true)` and the `version` setter throw the new `UncommittedEventsException`** (`ES_UNCOMMITTED_EVENTS`) while the aggregate has uncommitted events, and leave it unchanged. `loadFromHistory()` also accepts an array of events.
  - **`@Aggregate({ missingHandler: 'ignore' })`** applies events the aggregate has no `@EventHandler()` for. `'throw'`, the default, keeps throwing a `MissingEventHandlerException`.
  - **`SnapshotRepository.save()` no longer rejects.** It logs a snapshot that can't be serialized or stored: a version conflict as a warning, anything else as an error. It reads the versions a save covers from `markCommitted()` (or `commit()`), so a save from version 9 to 11 with an interval of 10 takes a snapshot, and a save that committed nothing takes none, even at a multiple of the interval. While the aggregate has uncommitted events, it logs a warning and takes no snapshot: 3.x stored a snapshot ahead of the stored events, and every later save of the stream conflicted.
  - **`generate()`, `from()` and `ULID.factory()` create an instance of the class they are called on**: `AccountId.generate()` returns an `AccountId` instead of a `UUID`, also when the factory is passed around, as in `values.map(AccountId.from)`. **Ids of different classes are never equal**, even with the same value. `InvalidIdException.idType` names the class the value was given to (`'AccountId'` instead of `'UUID'`).
  - **`ULID.from()` validates Crockford's base32**: 26 characters without I, L, O and U, in either case, starting with 0 to 7. 3.x accepted any 26 letters and digits. Event ids read from a store are not validated, so stored events stay readable.
  - **`ulidFactory` is deprecated**: it has always been a no-op. Use `ULID.factory()`. Removed in 5.0.
  - **`ValueObject.equals()` is null-safe**: it returns `false` for `null` and `undefined` instead of throwing, and compares the keys of the props, not only their number.
  
  **Migration**
  
  1. Save aggregates in three steps:
  
     ```ts
     // 3.x
     const events = account.commit();
     await this.eventStore.appendEvents(stream, account.version, events, pool);
     // 4.0
     const events = account.getUncommittedEvents();
     await this.eventStore.appendEvents(stream, events, { expectedVersion: account.committedVersion, pool });
     account.markCommitted(events);
     ```
  
     Call `markCommitted()` before `snapshotRepository.save()`, and load an aggregate (`loadFromHistory()`, or the `version` of a snapshot) before you apply new events to it.
  2. Where a handler reads `this.version`, add one to get the version of its event, as in 3.x.
  3. Where you compared ids of different classes with `equals()`, compare their `value`s. Where you matched `InvalidIdException.idType` against `'UUID'` or `'ULID'`, expect the name of your id class.
  4. `generate()`, `from()` and `ULID.factory()` call `new this(value)`. An id class whose constructor takes anything other than the id alone must declare its own `generate()`, `from()` and `factory()`. TypeScript doesn't catch this when the first parameter is a string: `from()` then passes your value to that parameter and returns an id with a different value. Make a `private` constructor `protected`, or the inherited factories no longer compile.
  5. If you relied on `SnapshotRepository.save()` rejecting, watch the logs instead, and call it after `markCommitted()`.

- [#578](https://github.com/ocoda/event-sourcing/pull/578) [`117cb88`](https://github.com/ocoda/event-sourcing/commit/117cb88f62796521fc28e8bb9f962a674d12139b) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **A JSON serializer replaces class-transformer as the default event serializer.** `JsonEventSerializer` serializes every event that has no `@EventSerializer()` of its own. It needs no decorators and no dependency. For events that use no class-transformer decorators, neither on the event class nor on the classes of the values it holds, it stores the same payloads and reads back the same events as 3.x, so stored events need no migration. See [Event Serialization](https://ocoda.github.io/event-sourcing/advanced/event-serialization) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#serialization).
  
  - **Same results as 3.x.** Nested class instances, value objects such as ids included, are stored as plain objects (`{ props: { value } }`) and read back as plain objects. A `Date` stays a `Date` in the payload: the SQL stores write an ISO string and read that string back, MongoDB stores a date. A `Set` becomes an array and a `Map` an object; getters and `toJSON` on the prototype are ignored. The values that the MongoDB driver returns as instances of its classes (a `Binary` for a buffer, a `Long` for an integer beyond 2^53, an `ObjectId`) read back as those instances, as in 3.x; so does a `Decimal128`, which 3.x failed to read. Deserializing calls the constructor without arguments, so its defaults fill the fields that older payloads lack, and it skips `__proto__`, `constructor`, methods and getters without a setter.
  - **class-transformer decorators can't lose their effect silently.** The JSON serializer ignores them, so:
    - An event class, or a parent class, with `@Type`, `@Transform`, `@Expose` or `@Exclude` that would get the JSON serializer fails the bootstrap with an `EventSourcingConfigurationException` that has a `class-transformer-decorators` issue for every such event, naming the event, its decorators and the fix.
    - An event that holds an instance of a class whose decorators changed the payload that 3.x stored (a value object or DTO with `@Expose`, `@Exclude`, `@Transform`, or a `@Type` with a discriminator) fails the append with an `EventSerializationException` (`reason: 'class-transformer-decorators'`), before it writes anything, and its `path` names the property that holds the instance. The bootstrap can't see those classes: a class nested in an event is only known once an event holds an instance of it. Without this check, an `@Exclude()`d field would be stored and an `@Expose({ name })` or `@Transform` would no longer apply.
    - Both checks find the decorators applied through class-transformer's CommonJS build, which Node loads. A bundler that resolves its ES module build keeps a second copy of the metadata, which they can't see.
  - **`ClassTransformerEventSerializer`**, from the new entry point `@ocoda/event-sourcing/class-transformer`, serializes with class-transformer as 3.x did. Use it for every event with `EventSourcingModule.forRoot({ defaultEventSerializer: ClassTransformerEventSerializer })` (`forRootAsync` too), or for one event with an `@EventSerializer(MyEvent)` class that extends it (see Event Serialization). `defaultEventSerializer` takes any `EventSerializerFactory`, an object with a `for(event)` method.
  - **class-transformer is an optional peer dependency** (`^0.5.1`) instead of a dependency. Install it if you use `ClassTransformerEventSerializer` or class-transformer's decorators.
  - **`DefaultEventSerializer` is removed** from `@ocoda/event-sourcing`, so code that used it chooses a serializer: `JsonEventSerializer` or `ClassTransformerEventSerializer`.
  - **A circular reference in an event** fails the append with an `EventSerializationException` (`reason: 'circular-reference'`, with the `path` of the reference) before anything is written. 3.x overflowed the stack.
  - `EventSerializationException` has the code `ES_EVENT_SERIALIZATION`. `EventSourcingConfigurationException` gets the issue kind `class-transformer-decorators`, and reports a `defaultEventSerializer` without a `for()` method as `invalid-options`. `EventMap.registerSerializers()` takes an options object as its third argument.
  
  **Migration**
  
  1. Replace `DefaultEventSerializer.for(MyEvent)` with `JsonEventSerializer.for(MyEvent)`, or with `ClassTransformerEventSerializer.for(MyEvent)` for an event with class-transformer decorators.
  2. Look for class-transformer decorators on your event classes and on the classes of the values they hold (value objects, DTOs). If you find any, install `class-transformer@^0.5.1` and set `defaultEventSerializer: ClassTransformerEventSerializer`, or give those events an `@EventSerializer()` of their own. The bootstrap fails for an event class with decorators, and an append fails for an event that holds an instance of a class with decorators; both name the event.
  3. If you bundle the application, the checks may not see the decorators: rely on step 2.

- [#579](https://github.com/ocoda/event-sourcing/pull/579) [`37c679c`](https://github.com/ocoda/event-sourcing/commit/37c679ca62393c8c3cc6208a995eadc2f83fd5f8) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The `EventSourcingModule` registers everything in `onModuleInit`, checks the whole configuration at bootstrap, connects the stores while the providers are instantiated, and resolves request-scoped command and query handlers per call.** This is the 4.0 module configuration of ADR 0001 (§3).
  
  - **Registration in `onModuleInit`, and on first use.** The command and query handlers, event subscribers, publishers and serializers of every module are discovered and registered in the module's `onModuleInit`. If a provider of another module (a `@Global()` module of yours, say) executes a command, appends or publishes from its own `onModuleInit` first, the registration runs right then. 3.x registered in `onApplicationBootstrap`, so events appended from `onModuleInit` were never published.
  - **Not ready during instantiation.** Appending or reading events (`appendEvents`, also of pre-built envelopes and with `publish: false`, `getEvent`, `getEvents`), executing a command or query, publishing (`eventBus.publish()`, `publishAll()`) or looking up the `EventMap` from a provider factory or a constructor throws the new `EventSourcingNotReadyException` (`ES_EVENT_SOURCING_NOT_READY`) before any I/O, naming the providers Nest was still instantiating. `eventBus.publish()` and `publishAll()` reject only in that case. Reading envelopes (`getEnvelope`, `getEnvelopes`, `readAll`) and `getStreamVersion` need no registration and work there.
  - **Configuration checks.** A misconfiguration fails the bootstrap with the new `EventSourcingConfigurationException` (`ES_EVENT_SOURCING_CONFIGURATION`), whose `issues` (`{ kind, message }`) list every problem at once: two event classes with one event name, two handlers for one command or query, two serializers for one event, a serializer or subscriber for an event that isn't registered, missing decorator metadata, request-scoped or transient subscribers, publishers and serializers, and options that can't work (`forRootAsync()` without a source, a store config without a `driver` class, an entry of `events` that isn't a class). 3.x kept one of the duplicates, or dropped the provider, silently. Providing one class in several modules, or listing an event more than once, is registered once.
  - **Request-scoped command and query handlers.** A handler that is request-scoped, transient or depends on a request-scoped provider is resolved for every call. One provided with `useFactory` is found when the handler class is its token (`{ provide: TheHandler, useFactory, scope: Scope.REQUEST }`). `commandBus.execute(command, { request })` and `queryBus.execute(query, { request })` resolve it in the DI context of that request, so it can `@Inject(REQUEST)`; the commands and queries of one request share its instances, and without a request every call gets new ones.
  - **Discovery by instance.** The decorators are read from the class of each provider's instance, so handlers, subscribers, publishers and serializers provided with `useFactory` or `useValue` are registered too.
  - **`forFeature` without global state.** `EventSourcingModule.forFeature({ events, serializers, imports })` registers its events in the applications that import it, through Nest's discovery, instead of a registry shared by the whole process: several applications in one process each get their own events. `serializers` are provided by the feature module, with their dependencies from `imports`.
  - **Stores.** The module creates, connects and (unless `useDefaultPool: false`) creates the default pool of both stores while the providers are instantiated, the snapshot store after the event store, so a bad connection or a table that needs its migration fails the bootstrap before any `onModuleInit`. A store that fails is disconnected again, and so is the event store when the snapshot store fails. The error is now thrown inside `NestFactory.create()`: with Nest's default `abortOnError: true`, Nest logs it and exits the process with code 1 instead of rejecting `app.listen()`, so pass `NestFactory.create(AppModule, { abortOnError: false })` to catch it; `Test.createTestingModule().compile()` rejects with it. The event and snapshot stores implement `OnApplicationShutdown` and disconnect there, after the `EventBus` drained; a failing disconnect is logged. The snapshot store's `useDefaultPool` is no longer passed to its driver.
  - **One global module.** `forRoot` and `forRootAsync` are built with Nest's `ConfigurableModuleBuilder` and return the global `EventSourcingModule` itself; the separate core module is gone. The flat `{ driver, ...driverOptions }` store configs, the typed `forRoot<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>()`, the in-memory default, the `EVENT_SOURCING_OPTIONS` token and `createEventSourcingOptions()` of `useClass`/`useExisting` factories stay.
  - **Deprecated:** `forRootAsync({ useValue })`, which emits a `DeprecationWarning` (`OCODA_ES_FOR_ROOT_ASYNC_USE_VALUE`) once; use `forRoot(options)`. Removed in 5.0. `forRootAsync()` without `useFactory`, `useClass` or `useExisting` throws an `EventSourcingConfigurationException` instead of an `Error`.
  - **Production warning.** When `NODE_ENV` is `production` and `eventStore` or `snapshotStore` is left out, the module warns that the in-memory store loses its events or snapshots on restart.
  - **Removed:** `EventRegistry`, `ExplorerService` and `getOptionsToken()`, which 3.x left reachable through paths inside the package.
  
  **Migration**
  
  1. Move code that appends, reads, executes or publishes from a provider factory or a constructor to `onModuleInit` or a later lifecycle hook:
  
     ```ts
     // 3.x
     { provide: 'SEED', inject: [EventStore], useFactory: (eventStore: EventStore) => seed(eventStore) }
     // 4.0
     @Injectable()
     class Seeder implements OnModuleInit {
     	constructor(private readonly eventStore: EventStore) {}
     	onModuleInit() {
     		return seed(this.eventStore);
     	}
     }
     ```
  
  2. Fix what the bootstrap reports in `EventSourcingConfigurationException.issues`: keep one handler per command or query and one serializer per event, register the events your subscribers and serializers name, and make subscribers, publishers and serializers singletons (resolve request-scoped dependencies with `ModuleRef.resolve()`).
  3. Pass the request to request-scoped handlers: `commandBus.execute(command, { request })`.
  4. Replace `forRootAsync({ useValue: options })` with `forRoot(options)`, and `getOptionsToken()` with `EVENT_SOURCING_OPTIONS` or `@InjectEventSourcingOptions()`.
  5. Tests that create several applications in one process no longer share the events of `forFeature`: import the feature module in each application that needs its events.

- [#569](https://github.com/ocoda/event-sourcing/pull/569) [`65303fc`](https://github.com/ocoda/event-sourcing/commit/65303fc99a48f65ec2b3f8c104f4f9b3b6d1644e) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The `EventBus` awaits asynchronous event publishers, reports every delivery failure on an observable, and drains the running publishers and subscribers when the application shuts down.** This is the 4.0 publishing pipeline of ADR 0001.
  
  - **Publishers are awaited, in order.** Each publisher gets the envelopes of an append in commit order, one call at a time: the bus awaits the promise that `publish` returns before it passes the next envelope, and `appendEvents` resolves once every publisher is done. 3.x fired asynchronous publishers and forgot them. Each publisher also gets the appends of a stream one after the other, in the order in which they were stored, even when they run concurrently; appends to other streams don't wait for each other. The publishers run concurrently, so a slow publisher holds back neither the others nor the subscribers, but it now slows down the commands whose events it publishes.
  - **Publisher timeout.** Each publisher call may take at most `publishing.publisherTimeout` milliseconds, 30 000 by default; `0` disables it. After that the bus logs the timeout, reports it and moves on to the next envelope. An append waits up to that timeout for each call, and for the calls of earlier appends to the same stream that a publisher still handles.
  - **Publishers that publish.** A publisher that appends events or calls `eventBus.publish()` from inside its `publish` gets those envelopes at once instead of waiting for itself. The subscribers are fed after the other publishers, so what a subscriber appends to a stream in reaction to an event reaches the publishers after that event.
  - **Batch publishers.** A publisher that implements `publishAll(envelopes)` gets the envelopes of an append in one call instead of one `publish` call each.
  - **`eventBus.publish()` returns a promise** that resolves once the publishers are done. Like `publishAll()`, it never rejects because of a publisher or subscriber. The envelopes of an append no longer go through `publish()`, so a spy on `eventBus.publish` sees nothing.
  - **Delivery errors.** `eventBus.deliveryErrors$.subscribe(({ kind, handler, envelope, error }) => …)` gets every publisher or subscriber that throws, rejects or (publishers only) times out; a timeout is a `DOMException` named `TimeoutError`. The failures are still logged, and still never make an append fail.
  - **`eventBus.whenIdle({ timeout })`** resolves once no publisher or subscriber is running. Without a timeout it waits as long as it takes; with one, it rejects with a `TimeoutError` when the bus is still busy after it.
  - **Shutdown.** `app.close()` now waits, in `beforeApplicationShutdown`, for the publishers and subscribers that are still running, for at most `publishing.shutdownTimeout` milliseconds (10 000 by default, `0` waits as long as it takes). Then, in `onApplicationShutdown`, the bus unsubscribes the subscribers and the event and snapshot stores disconnect, once each. 3.x did both in `onModuleDestroy`, which dropped the deliveries in flight.
  - **`IEventPublisher.publish`** returns `unknown` instead of `any` and no longer declares rest parameters, which the bus never passed. A publisher that returns its client's result keeps compiling; so does a `publishAll` that does. `IEventBus.publish` returns `Promise<void>`.
  - **Invalid timeouts** (negative, `NaN`, not a number) fail the bootstrap with a `RangeError`.
  
  **Migration**
  
  1. In tests, wait for the subscribers with `await eventBus.whenIdle()` instead of a fixed delay:
  
     ```ts
     // 3.x
     await commandBus.execute(command);
     await new Promise((resolve) => setTimeout(resolve, 50));
     // 4.0
     await commandBus.execute(command);
     await eventBus.whenIdle();
     ```
  
  2. Replace spies on `eventBus.publish` with a publisher of your own or a subscription to the bus, and `await eventBus.publish(envelope)` where you publish directly.
  3. If a publisher can take longer than 30 s, raise `publishing.publisherTimeout`, or set it to `0`, in `forRoot` or in the options of `forRootAsync`:
  
     ```ts
     EventSourcingModule.forRoot({ events, publishing: { publisherTimeout: 60_000, shutdownTimeout: 15_000 } });
     ```
  
  4. If your subscribers use providers that clean up in `onModuleDestroy`, which NestJS runs before the bus drains, call `await eventBus.whenIdle()` before `app.close()`.

- [#563](https://github.com/ocoda/event-sourcing/pull/563) [`433e151`](https://github.com/ocoda/event-sourcing/commit/433e1516810e0e654deda995fcd366755a3a288d) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The snapshot store API is Promise-only, and the in-memory snapshot store pages `loadAll` in binary order.** This is the 4.0 snapshot store contract of ADR 0001. The PostgreSQL, MariaDB and MongoDB snapshot stores already return promises; their cursor, order and highest-version reads come with their schema v2, and so does a single latest snapshot per stream when appends to it race.
  
  - **Every method of `SnapshotStore` returns a promise** (or an async generator), and a failure is a rejection. The in-memory store's `getSnapshot`, `getEnvelope`, `getLastSnapshot`, `getLastSnapshots`, `getLastEnvelope` and `getManyLastSnapshotEnvelopes` returned their result directly and threw synchronously, for example a `SnapshotNotFoundException`. They now have to be awaited. `SnapshotRepository` already awaited them.
  - **`getEnvelope` and `getEnvelopes` are required** (they were optional). `getManyLastSnapshotEnvelopes` and `getLastEnvelopesForAggregate` have defaults in the base class: the first reads the streams one by one with `getLastEnvelope`, so `SnapshotRepository.loadMany()` works with every store; the second rejects with an `UnsupportedOperationException` when it's read, which `loadAll()` passes on.
  - **`SnapshotStoreDriver` is now the class of a store**, `new (options) => SnapshotStore`, and `SnapshotStoreConfig.driver` has that type. It used to be an interface for a store instance.
  - **In-memory store:** the last snapshot of a stream is the one with the highest version, and `getLastEnvelopesForAggregate` (so `loadAll`) orders the streams in descending binary order of their aggregate ids, case-sensitively, with `aggregateId` as an exclusive cursor. It used to compare the ids ignoring case, so a page could skip a stream whose id differed from the cursor in case only.
  
  **Migration**
  
  1. Await the reads of an `InMemorySnapshotStore` that you call directly, and catch their failures as rejections:
  
     ```ts
     // 3.x
     const snapshot = snapshotStore.getSnapshot(stream, 10);
     // 4.0
     const snapshot = await snapshotStore.getSnapshot(stream, 10);
     ```
  
  2. In a custom snapshot store, make every method `async`, implement `getEnvelope` and `getEnvelopes`, and drop a `getManyLastSnapshotEnvelopes` that only loops over `getLastEnvelope`. An implementation of `getLastEnvelopesForAggregate` orders by aggregate id in descending binary order and treats `filter.aggregateId` as an exclusive cursor.
  3. Type store instances as `SnapshotStore` instead of `SnapshotStoreDriver`.
  4. If you page through `loadAll()` on the in-memory store with mixed-case aggregate ids, expect uppercase ids to come after lowercase ones.

- [#573](https://github.com/ocoda/event-sourcing/pull/573) [`c63ab9b`](https://github.com/ocoda/event-sourcing/commit/c63ab9bda8224fd8ba1d682525e92c8c588cad23) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The event store contract is final.** Every store now runs the appends and event reads of the `EventStore` base class, and the 3.x ways of reading all events are gone. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#read-all) and [Migrating a 3.x store](https://ocoda.github.io/event-sourcing/advanced/custom-stores#migrating-a-3x-store).
  
  - **`getAllEnvelopes`, `IAllEventsFilter`, `EventStore.getYearMonthRange` and `ULID.yearMonth` are removed.** Read a pool with `readAll({ fromPosition, batch, pool })`, and filter on `metadata.occurredOn` to read a period. For `ULID.yearMonth`, also on `EventId`, use `id.date.toISOString().slice(0, 7)`.
  - **A store that overrides `appendEvents`, `getEvent` or `getEvents` fails the bootstrap** with an `InvalidEventStoreImplementationException`, also when it overrides `appendEvents` the 3.x way. `this.eventMap` is removed too: the base class serializes and deserializes the events. Implement the driver methods instead; to decorate the appends of a store you extend, override its `persistEvents`.
  - **`getStreamVersion`, `readAll` and `persistEvents` are abstract**, like the other driver methods, so TypeScript reports a custom store that lacks one.
  - **`appendEvents` is declared as two overloads**: the options form, and the deprecated positional form, which keeps working until 5.0.

- [#565](https://github.com/ocoda/event-sourcing/pull/565) [`11dacb2`](https://github.com/ocoda/event-sourcing/commit/11dacb2f7a146245c19a3efd76e254b09fb4294e) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The 4.0 event store contract, implemented by the in-memory store.** The `EventStore` base class now implements appends and event reads for every store. The PostgreSQL, MariaDB and MongoDB stores implement it with their schema v2 (see their entries). See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#event-store-api).
  
  - **`appendEvents(stream, events, { expectedVersion, pool, metadata, publish })`.** `expectedVersion` is the version of the stream before the append: `ExpectedVersion.NoStream` (0) for a new stream, or `ExpectedVersion.Any`, which makes up to 16 attempts while concurrent appends take the versions, keeping the event ids. An `Any` append can still conflict under sustained contention on one stream; retry such a conflict in the application. `publish: false` stores without publishing, for imports and migrations.
  - **The positional form `appendEvents(stream, aggregateVersion, events, pool)` is deprecated** and emits a `DeprecationWarning` (`OCODA_ES_POSITIONAL_APPEND`) once per process. It will be removed in 5.0.
  - **Behaviour changes of appends**, in both forms, on the stores that implement the contract: an empty append returns `[]` without any I/O or publishing; an append whose expected version is above the version of the stream (a gap) conflicts; pre-built envelopes must continue the stream from the expected version, or the append throws an `InvalidEventEnvelopeException`; invalid options, metadata and envelopes are rejected before any I/O with `InvalidAppendOptionsException`, `InvalidEventMetadataException` or `InvalidEventEnvelopeException` (also the metadata of an empty append, and pre-built envelopes whose `eventId` is not an `EventId` or whose `occurredOn` is not a valid `Date`).
  - **Metadata and headers.** An append can set a `correlationId`, a `causationId` and `headers` for its events. Pre-built envelopes keep their own, and the options only fill the fields they lack. A store without the `headers` capability rejects headers with an `UnsupportedOperationException`.
  - **Global positions and `readAll({ fromPosition, batch, pool })`.** Every appended event gets a `globalPosition`, a bigint per pool starting at `1n`, returned by the append and by every read. `readAll` reads a pool across streams in that order, from an inclusive `fromPosition`; a `batch` that is not a positive integer throws a `RangeError`. The in-memory store implements it, is gap-safe, stores headers, and no longer has `getAllEnvelopes`.
  - **Stores are constructed with `(context, options)`.** The context holds the event map and the publisher (the `EventBus`), and the options no longer include `useDefaultPool`. `EventStoreDriver` is now the type of that constructor. `eventStore.publish = …` is removed: the store publishes through the context, and no longer logs a warning for events appended before the application bootstrapped.
  - **Custom stores** implement `getStreamVersion`, `getEnvelope`, `getEnvelopes`, `readAll` and `persistEvents`, and declare their `capabilities`. A store that overrides `appendEvents`, `getEvent` or `getEvents` fails the bootstrap with an `InvalidEventStoreImplementationException` (`assertEventStoreImplementation()` runs the check).
  - **Reads.** `getEvent()` always returns a promise. Every read of the in-memory store from a pool whose collection doesn't exist throws an `EventCollectionNotFoundException`, and an append to such a pool an `EventStorePersistenceException` with `outcome: 'not-persisted'`.

- [#568](https://github.com/ocoda/event-sourcing/pull/568) [`ee00755`](https://github.com/ocoda/event-sourcing/commit/ee007553983d7cdebba6bdf23bf557a83eebe834) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **Typed command and query buses.** `commandBus.execute()` and `queryBus.execute()` take their result type from the command or query, route by class, and reject instead of throwing. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#typed-buses).
  
  - **`Command<TResult>` and `Query<TResult>`** are new base classes. For `OpenAccountCommand extends Command<AccountId>`, `commandBus.execute(new OpenAccountCommand())` resolves to an `AccountId` without a type argument, `ICommandHandler<OpenAccountCommand>` resolves to it, and `@CommandHandler(OpenAccountCommand)` rejects a handler that resolves to something else. `Command` without a type argument is `Command<void>`. The classes add no property, so payloads are unchanged. `ResultOf<T>` is the result type of a command or query class.
  - **3.x commands and queries keep compiling.** A plain class still works as a command or query, and `execute()` resolves to `any` for it. `execute<AddBookCommand>(command)` and `execute<OpenAccountCommand, AccountId>(command)` compile unchanged. The result type is no longer inferred from the variable it is assigned to.
  - **TypeScript 5.4 or later.** The declarations of `execute()` use `NoInfer`, so an older compiler reports `Cannot find name 'NoInfer'`, or, with `skipLibCheck`, types every result as `any`.
  - **`ICommand` and `IQuery` are `object`** instead of `any`: a primitive, `null`, `undefined`, a value typed `unknown` or an unconstrained type parameter no longer type-checks as a command or query.
  - **`execute()` always returns a promise.** A command or query without a handler rejects with a `CommandHandlerNotFoundException` or `QueryHandlerNotFoundException` (it threw synchronously) and publishes nothing. A handler that throws synchronously rejects too.
  - **Handlers are registered by class**, not by an id stored on the class. A command or query reaches the handler of its class or, if there is none, of its nearest parent class, so a subclass without a handler of its own still reaches its parent's. A subclass with a handler of its own now reaches it: in 3.x it inherited its parent's id, and the handler registered last handled both classes. A class without any handler rejects with the not-found exception instead of throwing `MissingCommandMetadataException` or `MissingQueryMetadataException`. Those exceptions, `getCommandMetadata()`, `getQueryMetadata()`, `CommandMetadata` and `QueryMetadata` are deprecated and will be removed in 5.0. `bind(handler, command)` on the buses takes the class instead of the id.
  - **The decorators take classes.** `@CommandHandler()`, `@QueryHandler()`, `@EventSubscriber()` and `@EventSerializer()` no longer accept other values, and the class passed to them needs a public constructor. `@CommandHandler()` and `@QueryHandler()` require the decorated class to have an `execute()` that returns a promise, and return a decorator typed for the handler class instead of a `ClassDecorator`: to compose them with `applyDecorators()` under `strictFunctionTypes`, cast them (`CommandHandler(OpenAccountCommand) as ClassDecorator`), which skips the check of the result type.
  - `execute()` takes an optional `{ request }` argument for request-scoped handlers, which the bus resolves in the DI context of that request (see the module configuration entry of this release).
  
  **Migration**
  
  1. Assert a missing handler as a rejection: `await expect(commandBus.execute(command)).rejects.toThrow(CommandHandlerNotFoundException)`.
  2. Catch `CommandHandlerNotFoundException` and `QueryHandlerNotFoundException` where you caught `MissingCommandMetadataException` and `MissingQueryMetadataException`.
  3. Where a command or query class and its subclass both have a handler, check that each handler expects only its own class.
  4. Make the `execute()` of every decorated handler return a promise, for example by making it `async`.
  5. Constrain the type parameters you pass to `execute()` (`<C extends ICommand>`), make the constructors of command and query classes public, and cast the handler decorators you pass to `applyDecorators()`.
  6. Optionally, extend `Command<TResult>` and `Query<TResult>` (constructors call `super()`) and drop the type arguments of `execute()`.

### Minor Changes

- [#596](https://github.com/ocoda/event-sourcing/pull/596) [`f124698`](https://github.com/ocoda/event-sourcing/commit/f1246981d8e46ec56157e7e15e36a1f63538fac2) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The MariaDB migration keeps 3.x streams whose ids differ in case only as one stream, and needs less work by hand.** The 3.x tables compared stream ids case-insensitively, so one 3.x stream could hold `account-Acc-1` version 1 and `account-acc-1` version 2. Schema v2 compares stream ids in binary, and the migration used to split such a stream into two, one of them starting at version 2.
  
  - **One stream id per 3.x stream.** `MariaDBEventStore.migrate()` gives every row of such a stream the stream id of its lowest version (`account-Acc-1`), and a renamed row the aggregate id of that version when the two differ in case only. `MariaDBSnapshotStore.migrate()` gives every snapshot stream the stream id of its events, from the pool's 3.x event table or its `__es_v1` backup, or else the id of its lowest snapshot. It is deterministic, and a rerun after a crash ends in the same state. **After the migration, use those stream ids**: 4.0 reads `account-acc-1` as another, empty stream. Keep the events' backups (the default) until the snapshots are migrated.
  - **The report lists them.** A new `canonicalizedStreams: { total, rows, sample }` on `MigrationCollectionReport` gives, per stream, the id it takes, the ids it replaces and the rows that change (a sample of up to 1,000 streams), in the dry run and in the migration's report, with a warning that shows a few. `caseVariantStreams` now also counts snapshot streams. `gappedStreams` and `snapshotFlags` count a 3.x stream once, so a case-variant stream no longer shows up as gapped.
  - **A missing privilege fails before the copy.** The event migration renames the empty copy and back (`probe-swap`), which needs the swap's privileges, so a user without `ALTER` fails there instead of at the swap after the whole copy. The dry run still can't check privileges.
  - **Lock waits name the sessions.** With the `PROCESS` privilege, a step that times out on a lock lists the sessions with an open transaction (`KILL <id>` ends one).
  - **Galera.** The migration replicates in fragments of 64 MiB, or of half the node's `wsrep_max_ws_size` when that is smaller, so it no longer fails on a smaller `wsrep_max_ws_size`.
  - **Dropping the backups** needs no SQL: run `MariaDBEventStore.migrate(config, { keepBackup: false })` again, after the snapshots are migrated. When `keepBackup: false` would drop the backup of a pool whose snapshot table isn't migrated yet, the dry run and the report warn about it.
  - `migrations/4.0.sql` has the new statements, and suggests dropping the events' backup only after the snapshots.

- [#561](https://github.com/ocoda/event-sourcing/pull/561) [`29aa8fe`](https://github.com/ocoda/event-sourcing/commit/29aa8fee3d881524e37095a281c592b0b1f1464b) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **Groundwork for the 4.0 event store contract.** The additions that the store contract, in its own entry of this release, builds on.
  
  - **`EventEnvelope.create` keeps the generated event id when `eventId` is `undefined`.** Passing `eventId: undefined` explicitly used to replace the generated id with `undefined`. `create` also takes an optional `occurredOn`, which still defaults to the time of the event id.
  - **`EventEnvelope.toJSON()`.** `JSON.stringify(envelope)` writes a bigint, such as the upcoming global position, as a decimal string instead of throwing. It also writes the event id as a string, see its own entry of this release.
  - **Envelope metadata** has three new optional fields: `headers`, `eventVersion` and `globalPosition` (a bigint).
  - **New exceptions, each with its own code:** `InvalidEventEnvelopeException` (`ES_INVALID_EVENT_ENVELOPE`), `InvalidEventMetadataException` (`ES_INVALID_EVENT_METADATA`), `InvalidAppendOptionsException` (`ES_INVALID_APPEND_OPTIONS`), `EventCollectionNotFoundException` (`ES_EVENT_COLLECTION_NOT_FOUND`), `InvalidEventStoreImplementationException` (`ES_INVALID_EVENT_STORE_IMPLEMENTATION`) and `EventStoreSchemaException` (`ES_EVENT_STORE_SCHEMA`).
  - **Types** for the append options (`AppendOptions`, `AppendMetadata`, `EventHeaders`), the capabilities of a store (`EventStoreCapabilities`), what a store is constructed with (`EventStoreContext`, `EnvelopePublisher`), the result of a write (`PersistOutcome`, `PersistTarget`), reading a whole pool (`IReadAllFilter`) and schema migrations (`MigrationOptions`, `MigrationReport`, `SchemaOptions`).
  - **Helpers for store implementations:**
    - `toPosition()` converts a global position as a database driver returns it (a decimal string, a number, a bigint or an Int64 object) to a bigint, and rejects anything that isn't a non-negative integer.
    - `resolveCapabilities()` fills in the capabilities a store leaves out with `DEFAULT_EVENT_STORE_CAPABILITIES`.
    - `EVENT_STORE_LIMITS`: at most 255 characters for stream ids, aggregate ids, event names, correlation ids and causation ids, and 8 KiB for the headers of an event.
    - `EventId.fromTrusted()` wraps an event id read from a store without validating it, so that stored events stay readable if id validation gets stricter.
    - `ANY_MAX_ATTEMPTS`, how often an append with `ExpectedVersion.Any` will be tried.
  - **`EventBus.publishAll(envelopes)`** publishes the envelopes of an append in order. The publishing entry of this release describes how it awaits the publishers.

- [#576](https://github.com/ocoda/event-sourcing/pull/576) [`57b20c5`](https://github.com/ocoda/event-sourcing/commit/57b20c55a6dbed7632e0e0511f0cfba3efb5a519) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **`@ocoda/event-sourcing/testing`: the store conformance suites are published.** A custom event store or snapshot store can now run the suites that every built-in store runs, and prove it implements the 4.0 store contract. See [Test your Event Store](https://ocoda.github.io/event-sourcing/advanced/custom-stores#test-your-event-store) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#custom-store-conformance).
  
  ```ts
  import { describeEventStoreConformance, describeSnapshotStoreConformance } from '@ocoda/event-sourcing/testing';
  
  describeEventStoreConformance('FooEventStore', async (context) => {
  	const store = new FooEventStore(context, { ... });
  	await store.connect();
  	return { store, cleanup: async (collections) => { /* drop them, then disconnect */ } };
  });
  ```
  
  - **Vitest.** The suites register [Vitest](https://vitest.dev) tests. `vitest` (`^4.0.0 || ^5.0.0`) is an optional peer dependency of `@ocoda/event-sourcing`: install it to use the subpath. The suites import Vitest's API, so they run without `globals: true`, and the root entry point never loads Vitest. npm checks an optional peer whenever the project has that package, so a project on another major of Vitest gets `ERESOLVE` from `npm install` until it moves to Vitest 4 or 5 or installs with `--legacy-peer-deps`; pnpm and Yarn only warn.
  - **What the subpath exports.** `describeEventStoreConformance(name, (context) => handle, options)` and `describeSnapshotStoreConformance(name, () => handle, options)`, the case ids (`EVENT_STORE_CONFORMANCE_CASES`, `SNAPSHOT_STORE_CONFORMANCE_CASES`) and the handle types (`EventStoreConformanceHandle`, `SnapshotStoreConformanceHandle`); the `RecordingPublisher`, which records what a store publishes; and helpers for tests on the in-memory stores: `createTestEventStoreContext({ events })`, `createInMemoryEventStore({ events })` and `createInMemorySnapshotStore()`.
  - **Capabilities gate cases.** A case that needs a capability the store doesn't claim is skipped with `capability: <flag>`, and `skip` takes the remaining gaps, each with a reason. A snapshot store that keeps the base class's `getLastEnvelopesForAggregate`, which rejects every read with an `UnsupportedOperationException`, skips the cases of that read the same way.
  - `CONFORMANCE_RUN_SKIPPED=true` runs the skipped cases, and `CONFORMANCE_REPEAT=n` runs every case n times.

## 4.0.0-next.1

### Major Changes

- [#556](https://github.com/ocoda/event-sourcing/pull/556) [`c82f392`](https://github.com/ocoda/event-sourcing/commit/c82f3923123f5b02def706f10984cd8a69c61c4a) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **Every exception class the library exports now has a stable `code`, the fields that describe it and the original error as its `cause`.** Match errors on their code instead of their message or constructor.
  
  - **`EventSourcingError` and `isEventSourcingError()`.** All library exceptions extend the new abstract `EventSourcingError` and keep their class names, so `instanceof` checks keep working. Each has a literal `name` that survives minification and a unique `code` from the new `EventSourcingErrorCode` object (for example `EventSourcingErrorCode.EventStoreVersionConflict`, `'ES_EVENT_STORE_VERSION_CONFLICT'`). `isEventSourcingError(error, code?)` narrows an unknown error, to the exception class of the code when one is given (so `error.actualVersion` of a conflict is typed), and also recognises errors from a second copy of the package, as does `error instanceof EventSourcingError`.
  - **Errors say what went wrong in their fields.** `EventStoreVersionConflictException` has `streamId`, `aggregateId`, `pool`, `expectedVersion` (the version the stream had to have before the append) and `actualVersion` (left out when the append lost a race on the unique key). `EventStorePersistenceException` has `collection` and an `outcome`: `'not-persisted'` when nothing was written, `'unknown'` when the events may have been stored. Retrying with the same expected version is safe in both cases, because a duplicate append conflicts. The not-found and metadata exceptions name the class or stream they concern (`commandName`, `queryName`, `eventName`, `streamId`, `version`, ...), and `CommandHandlerNotFoundException` now names the command class instead of an internal id.
  - **The stack is kept.** Wrapping exceptions used to replace their own stack with the stack of the driver error. The driver error is now the standard `cause`, and the stack points at where the exception was thrown.
  - **Messages changed**, for version conflicts in particular. Code that matches on `error.message` should match on `error.code` and the fields instead.
  - **`UnsupportedOperationException` replaces `NotImplementedException`.** `SnapshotRepository.loadMany()` and `loadAll()` threw the `NotImplementedException` of `@nestjs/common` when the snapshot store lacks `getManyLastSnapshotEnvelopes` or `getLastEnvelopesForAggregate`. They now throw `UnsupportedOperationException`, with the method name in `operation`. That class was never exported by this package, so there is no alias. An HTTP exception filter that relied on the 501 status of the Nest exception should map the new code instead.
  - **`DomainException` gets a `name` and a `cause`.** Its `name` is the class name of your subclass, and its constructor takes the standard error options as a third argument: `super(message, id, { cause })`. A subclass that defines its own `name` (a field, a getter or on its prototype) keeps it. It has no `code`, so existing subclasses compile unchanged. `InvalidIdException` still extends `DomainException`, so exception filters for domain errors keep catching it, and is also an `EventSourcingError` with a code, the rejected `value` and the `idType` of the id class that rejected it.
  - **Exceptions take one object argument.** Every exported exception is constructed with a single, null-safe details object, plus the standard error options for the `cause`. The static factories `InvalidIdException.becauseInvalid()`, `becauseEmpty()` and `because()`, `IdNotFoundException.withId()`, `IdAlreadyRegisteredException.withId()`, `InvalidAggregateStreamNameException.becauseExceedsMaxLength()` and `InvalidEventStreamNameException.becauseExceedsMaxLength()` still work, as does the 3.x `super(message, id)` call of an `InvalidIdException` subclass, but they are deprecated and will be removed in 5.0.
  - **`ExpectedVersion`** is a new export: `ExpectedVersion.NoStream` (0) and `ExpectedVersion.Any`, and the `ExpectedVersion` type of `expectedVersion`.
  
  **Migration**
  
  1. Match errors on their code and fields rather than their message or constructor:
  
     ```ts
     // 3.x
     if (error instanceof EventStoreVersionConflictException && error.message.includes('latest is')) { … }
     if (error.constructor === EventStoreVersionConflictException) { … }
     // 4.0
     if (isEventSourcingError(error, EventSourcingErrorCode.EventStoreVersionConflict)) {
     	console.log(error.streamId, error.expectedVersion, error.actualVersion);
     }
     ```
  
  2. Code that constructs library exceptions, such as a custom event or snapshot store, passes one object and puts the underlying error in the options:
  
     ```ts
     // 3.x
     throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion, error);
     throw new EventStorePersistenceException(collection, error);
     throw new EventNotFoundException(stream.streamId, version);
     // 4.0
     throw new EventStoreVersionConflictException(
     	{ stream, expectedVersion: aggregateVersion - events.length, actualVersion: currentVersion, pool },
     	{ cause: error },
     );
     throw new EventStorePersistenceException({ collection, outcome: 'unknown' }, { cause: error });
     throw new EventNotFoundException({ streamId: stream.streamId, version, pool });
     ```
  
  3. Replace `NotImplementedException` from `@nestjs/common` with `UnsupportedOperationException` (or `EventSourcingErrorCode.UnsupportedOperation`) where you catch the errors of `SnapshotRepository.loadMany()` and `loadAll()`.
  4. Read the underlying error of a wrapping exception from `error.cause` instead of from its stack.

## 4.0.0-next.0

### Major Changes

- [#543](https://github.com/ocoda/event-sourcing/pull/543) [`95b19f2`](https://github.com/ocoda/event-sourcing/commit/95b19f2a6e3681f4968795f2c83749c6e88f83e5) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Move to NestJS 12 and publish the packages as ES modules only.
  
  **Breaking changes**
  
  - **NestJS 12 only.** The core peers on `@nestjs/common` and `@nestjs/core` `^12.0.0` and on `rxjs` `^7.8.0`. NestJS 11 applications stay on 3.x, which keeps receiving fixes.
  - **ESM-only.** Every package ships one ES module build (`"type": "module"`), and its `exports` map points `import`, `require` and `default` at the same file. ESM applications import the packages as before. CommonJS applications, including TypeScript compiled to CommonJS, keep using `require()`: Node.js 22.12 and later load ES modules through `require()` natively. Because there is no second CommonJS build, Nest never sees two copies of a class such as `EventStore`.
  - **Node.js 22.12 or later** is required (`engines.node` is `>=22.12`).
  - **The database drivers are peer dependencies.** The integrations no longer install their driver, so install it next to the integration, in the version you choose:
    - `@ocoda/event-sourcing-postgres`: `pg` (`^8.15.0`, the first release with an ES module entry) and `pg-cursor` (`^2.14.0`). TypeScript projects also need `@types/pg` and `@types/pg-cursor`.
    - `@ocoda/event-sourcing-mongodb`: `mongodb` (`^6.10.0 || ^7.0.0`).
    - `@ocoda/event-sourcing-mariadb`: `mariadb` (`^3.0.0`).
  - The integrations now peer on `@nestjs/common` `^12.0.0` and on `@ocoda/event-sourcing` with a caret range (`^4.0.0`) instead of an exact version. They no longer list `@nestjs/core`, `rxjs` or `reflect-metadata`, which they do not import.
  - **The root entry shims are gone.** The `index.js`, `index.d.ts` and `index.ts` files next to each `package.json` were removed, and `exports` exposes only the package root and `package.json`. Import from the package name (`@ocoda/event-sourcing`, `@ocoda/event-sourcing-postgres`, ...); paths into the package, such as `@ocoda/event-sourcing/dist/...`, no longer resolve.
  
  The stored event and snapshot formats are unchanged, so no data migration is needed.
  
  **Migrating from 3.x**
  
  1. Upgrade the application to NestJS 12 and Node.js 22.12 or later.
  2. Install the driver of every integration you use, for example `npm install pg pg-cursor` for PostgreSQL or `npm install mongodb` for MongoDB.
  3. Replace any import of a path inside the packages with an import from the package name.
  4. CommonJS applications need no code changes. A test runner with its own module loader, such as Jest, loads these packages with the same setup it needs for NestJS 12, which is ESM-only as well.
  
  The DynamoDB store (`@ocoda/event-sourcing-dynamodb`) is not released for 4.0, because DynamoDB can't give the events the gap-free global order that the 4.0 read side relies on. To keep using DynamoDB, stay on 3.x, which keeps receiving fixes, or move to the PostgreSQL, MariaDB or MongoDB store.

- [#548](https://github.com/ocoda/event-sourcing/pull/548) [`c87efea`](https://github.com/ocoda/event-sourcing/commit/c87efea2581cf403012672d2dd4e02688541e5a0) Thanks [@drieshooghe](https://github.com/drieshooghe)! - 4.0 is the next major release: NestJS 12, ESM-only packages, Node.js 22.12 or later, and more. Every breaking change has its own entry in this changelog, with the steps to migrate from 3.x.

### Patch Changes

- [#540](https://github.com/ocoda/event-sourcing/pull/540) [`c9b66f7`](https://github.com/ocoda/event-sourcing/commit/c9b66f702081e5fa0a39f0d7f714a4ba87b184ef) Thanks [@drieshooghe](https://github.com/drieshooghe)! - `InMemoryEventStore.appendEvents` now rejects an append whose first version already exists with an `EventStoreVersionConflictException`. Before, appending two events at version 4 to a stream at version 3 stored a second event with version 3. The database stores already reject this through their unique (stream, version) key.

## 3.0.1

### Patch Changes

- [#524](https://github.com/ocoda/event-sourcing/pull/524) [`c2f0b47`](https://github.com/ocoda/event-sourcing/commit/c2f0b479ad295d0c92b1cf3c522bac23424c8c81) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix reliability issues in the core package:

  - **Event subscribers are isolated.** Before this fix, if an `@EventSubscriber` threw or returned a rejected promise, that subscriber was unsubscribed for good and the error was rethrown as an uncaught exception, which crashed the process. Now the error is logged (logger context `EventBus`, with the event and subscriber name). The subscriber keeps receiving later events, and other subscribers are unaffected.
  - **Publishing can no longer fail an append after the events are persisted.** If an `@EventPublisher` throws or rejects (async publishers were never awaited, so a rejection crashed the process), the error is now logged. The remaining publishers and envelopes are still published, and `appendEvents` resolves.
  - **Appending before publishing is wired no longer throws.** The event store's publish function is set when the application bootstraps (`onApplicationBootstrap`). When `appendEvents` runs before that, for example on a store used outside of a bootstrapped application, the events are persisted and returned but not published, and a single warning is logged. Before, the append threw a `TypeError` after the events had already been persisted.
  - **`EventSourcingModule.forRootAsync({ useClass })` works.** The module now instantiates the options factory class itself, resolving its dependencies from `imports` and global modules. If the class is already provided (for example exported by one of the `imports`, which used to be required), that instance is still reused. `forRootAsync()` also throws a descriptive error when none of `useFactory`, `useClass`, `useExisting` or `useValue` is given.
  - **In-memory stores.** `ensureCollection()` only creates missing pools and no longer wipes an existing pool's events or snapshots. `disconnect()` no longer throws when the store was never connected. `InMemorySnapshotStore.getLastEnvelopesForAggregate` now pages correctly: results stay filtered by aggregate and sorted in descending stream order, and `aggregateId` works as an exclusive "after" cursor, so pages don't overlap.
  - **Snapshots are no longer skipped when a save jumps over an interval boundary** (for example from v9 to v11 with interval 10). `SnapshotRepository.save` uses the versions recorded by the aggregate's last `commit()`. It takes a snapshot when those committed events cross an interval boundary or the first version, so a new aggregate created with several events now gets its first snapshot. When the committed versions are unknown, the previous rule applies (version 1 and multiples of the interval).
  - **Subscribing to a bus now emits values.** `eventBus.pipe(...)` and `commandBus.subscribe(...)` used to produce nothing. Now they receive the published envelopes, commands and queries, as they do in `@nestjs/cqrs`. The existing subject$ getter keeps working.
  - **The default `until` month of `getAllEnvelopes` is computed in UTC,** so events of the current UTC month are no longer missed in timezones behind UTC.
  - **`InMemoryEventStore` and `InMemorySnapshotStore` are exported from the package root,** together with their config and entity types.

## 3.0.0

### Minor Changes

- [#474](https://github.com/ocoda/event-sourcing/pull/474) [`6290979`](https://github.com/ocoda/event-sourcing/commit/6290979d9727a1edbede492c19a330ddef5ba736) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Add feature-module registration helpers, exploration service, and flexible store configuration for event sourcing.

### Patch Changes

- [#474](https://github.com/ocoda/event-sourcing/pull/474) [`7a14fea`](https://github.com/ocoda/event-sourcing/commit/7a14feab663e0d0f323b017127e2771aae6b9183) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Expand shared E2E coverage, align integration test structure, and add core bus edge-case tests.

## 2.1.4

### Patch Changes

- [#445](https://github.com/ocoda/event-sourcing/pull/445) [`44b1c31`](https://github.com/ocoda/event-sourcing/commit/44b1c311f06bbc800997934d0c18401f4b214895) Thanks [@renovate](https://github.com/apps/renovate)! - Update all non-major dependencies

- [#450](https://github.com/ocoda/event-sourcing/pull/450) [`0ca4ef4`](https://github.com/ocoda/event-sourcing/commit/0ca4ef4cd413f0196f09917d6037b76604fc00f1) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix serializing event payloads to save to Postgres

## 2.1.3

### Patch Changes

- [#442](https://github.com/ocoda/event-sourcing/pull/442) [`c8762dc`](https://github.com/ocoda/event-sourcing/commit/c8762dcb54b2be608b85d4dfb80b7f0880ee828d) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

## 2.1.2

### Patch Changes

- [#433](https://github.com/ocoda/event-sourcing/pull/433) [`d645eaa`](https://github.com/ocoda/event-sourcing/commit/d645eaac2b7aca74303eb2908c6af64bd3491d92) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

## 2.1.1

### Patch Changes

- [#422](https://github.com/ocoda/event-sourcing/pull/422) [`2711e2e`](https://github.com/ocoda/event-sourcing/commit/2711e2e3d26b1ee5ea76e6c0922e92f86ef74a4b) Thanks [@MartinLG-LaFourche](https://github.com/MartinLG-LaFourche)! - # Enhancements
  Enforces the linter to check for strictNullChecks.

  # Dependencies

  Updated various dependencies to their latest versions.

## 2.1.0

### Minor Changes

- [#419](https://github.com/ocoda/event-sourcing/pull/419) [`cbc7b08`](https://github.com/ocoda/event-sourcing/commit/cbc7b082555cb0855cd26965020b152c679e6e47) Thanks [@drieshooghe](https://github.com/drieshooghe)! - # Fixes
  Fixes an issue where the metadata from custom event-serializers wasn't returned as an object, resulting in them not being registered by the handlers loader.

  # Deprecates

  Removes the `disableDefaultSerializer` option from the module, but falls back to the default serializer for each event that doesn't have a custom event-serializer registered. Refactored because the previous behavior left the event-serializer for an event empty, which doesn't make sense.

  # Dependencies

  Updated various dependencies to their latest versions, including:

  - `@aws-sdk/client-dynamodb` & `@aws-sdk/util-dynamodb` to `3.758.0`
  - `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, and `@nestjs/testing` to `11.0.11`
  - `@changesets/changelog-github` & `@changesets/cli` to their latest versions
  - `@faker-js/faker` to `9.5.1`
  - `@swc/core` to `1.11.5`
  - `mongodb` to `6.14.0`
  - `next` to `15.2.0`
  - `pg` to `8.13.3` and `pg-cursor` to `2.12.3`
  - `rxjs` to `7.8.2`
  - `tsup` to `8.4.0`
  - `turbo` to `2.4.4`
  - `typescript` to `5.8.2`

  These updates include minor fixes, performance improvements, and compatibility enhancements.

## 2.0.0

### Major Changes

- [#406](https://github.com/ocoda/event-sourcing/pull/406) [`d22f846`](https://github.com/ocoda/event-sourcing/commit/d22f8463febe06e43282a10c6fcafdd43a9877e7) Thanks [@renovate](https://github.com/apps/renovate)! - Major bump NestJS dependencies

  - Drops support for NodeJS 18 as it is no longer supported by NestJS v11
  - Bumps dev dependencies

## 1.1.6

### Patch Changes

- [#407](https://github.com/ocoda/event-sourcing/pull/407) [`475513a`](https://github.com/ocoda/event-sourcing/commit/475513a6eaa92d3e8e8b2383f539a7518264fd5b) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.5

### Patch Changes

- [#402](https://github.com/ocoda/event-sourcing/pull/402) [`2ea7e18`](https://github.com/ocoda/event-sourcing/commit/2ea7e1849fe3ac4b623246b7662f0e6480be4594) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.4

### Patch Changes

- [#400](https://github.com/ocoda/event-sourcing/pull/400) [`f83eb04`](https://github.com/ocoda/event-sourcing/commit/f83eb045648f107282761f807d870f8844df2bd9) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.3

### Patch Changes

- [#393](https://github.com/ocoda/event-sourcing/pull/393) [`4375b25`](https://github.com/ocoda/event-sourcing/commit/4375b25ea95ec6dd954ae6f34d8e3797ebbefb36) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.2

### Patch Changes

- [#388](https://github.com/ocoda/event-sourcing/pull/388) [`154d20a`](https://github.com/ocoda/event-sourcing/commit/154d20ae3a4845e273c47d970c1b2f3f25daf1f0) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.1

### Patch Changes

- [#384](https://github.com/ocoda/event-sourcing/pull/384) [`9f9af0e`](https://github.com/ocoda/event-sourcing/commit/9f9af0e3bfa36239121886635013ca515f38b09f) Thanks [@renovate](https://github.com/apps/renovate)! - Update dependencies

## 1.1.0

### Minor Changes

- [#371](https://github.com/ocoda/event-sourcing/pull/371) [`eff4abd`](https://github.com/ocoda/event-sourcing/commit/eff4abda2b44a7fbcb1be7bccde7fc9267e7fded) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Support for a getAllEnvelopes method on the EventStore

## 1.0.2

### Patch Changes

- [#361](https://github.com/ocoda/event-sourcing/pull/361) [`5be1d42`](https://github.com/ocoda/event-sourcing/commit/5be1d42d1eb0a19a252d2127b72a756b3cd701f6) Thanks [@renovate](https://github.com/apps/renovate)! - Dependency updates

## 1.0.1

### Patch Changes

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`8081e16`](https://github.com/ocoda/event-sourcing/commit/8081e16d3edcab21efa301a7e1261cfd062ab4e7) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Introduce ULID based event-ids and make sure these are persisted/retrieved correctly within the integrations

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`94e41eb`](https://github.com/ocoda/event-sourcing/commit/94e41ebea9a5d3762d39db0a3afb664bc0d78010) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Adds a `listCollections` method to all integrations

## 1.0.0

### Major Changes

- This marks the first stable release of the library, which consists of the following changes:

  - all database-specific libraries have been migrated to their own libraries to reduce the bundle size
  - the `SnapshotHandler` was renamed to `SnapshotRepository`
  - the `SnapshotRepository` was provided with additional methods for retrieving snapshots in bulk
  - the database drivers were optimized (e.g. by only fetching the needed fields)
  - the DynamoDB snapshot-store serialization was fixed
