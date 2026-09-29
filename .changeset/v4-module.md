---
'@ocoda/event-sourcing': major
---

**The `EventSourcingModule` registers everything in `onModuleInit`, checks the whole configuration at bootstrap, connects the stores while the providers are instantiated, and resolves request-scoped command and query handlers per call.** This is the 4.0 module configuration of ADR 0001 (§3).

- **Registration in `onModuleInit`, and on first use.** The command and query handlers, event subscribers, publishers and serializers of every module are discovered and registered in the module's `onModuleInit`. If a provider of another module (a `@Global()` module of yours, say) executes a command, appends or publishes from its own `onModuleInit` first, the registration runs right then. 3.x registered in `onApplicationBootstrap`, so events appended from `onModuleInit` were never published.
- **Not ready during instantiation.** Using the event store, the `EventMap`, the `CommandBus`, the `QueryBus` or `EventBus.publishAll()` from a provider factory or a constructor throws the new `EventSourcingNotReadyException` (`ES_EVENT_SOURCING_NOT_READY`) before any I/O, naming the providers Nest was still instantiating. `eventBus.publish()` and `publishAll()` reject only in that case.
- **Configuration checks.** A misconfiguration fails the bootstrap with the new `EventSourcingConfigurationException` (`ES_EVENT_SOURCING_CONFIGURATION`), whose `issues` (`{ kind, message }`) list every problem at once: two event classes with one event name, two handlers for one command or query, two serializers for one event, a serializer or subscriber for an event that isn't registered, missing decorator metadata, request-scoped or transient subscribers, publishers and serializers, and options that can't work (`forRootAsync()` without a source, a store config without a `driver` class, an entry of `events` that isn't a class). 3.x kept one of the duplicates, or dropped the provider, silently. Providing one class in several modules, or listing an event more than once, is registered once.
- **Request-scoped command and query handlers.** A handler that is request-scoped, transient or depends on a request-scoped provider is resolved for every call. `commandBus.execute(command, { request })` and `queryBus.execute(query, { request })` resolve it in the DI context of that request, so it can `@Inject(REQUEST)`; the commands and queries of one request share its instances, and without a request every call gets new ones.
- **Discovery by instance.** The decorators are read from the class of each provider's instance, so handlers, subscribers, publishers and serializers provided with `useFactory` or `useValue` are registered too.
- **`forFeature` without global state.** `EventSourcingModule.forFeature({ events, serializers, imports })` registers its events in the applications that import it, through Nest's discovery, instead of a registry shared by the whole process: several applications in one process each get their own events. `serializers` are provided by the feature module, with their dependencies from `imports`.
- **Stores.** The module creates, connects and (unless `useDefaultPool: false`) creates the default pool of both stores while the providers are instantiated, so a bad connection or a table that needs its migration fails the bootstrap before any `onModuleInit`, and a store that fails is disconnected again. The event and snapshot stores implement `OnApplicationShutdown` and disconnect there, after the `EventBus` drained; a failing disconnect is logged. The snapshot store's `useDefaultPool` is no longer passed to its driver.
- **One global module.** `forRoot` and `forRootAsync` are built with Nest's `ConfigurableModuleBuilder` and return the global `EventSourcingModule` itself; the separate core module is gone. The flat `{ driver, ...driverOptions }` store configs, the typed `forRoot<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>()`, the in-memory default, the `EVENT_SOURCING_OPTIONS` token and `createEventSourcingOptions()` of `useClass`/`useExisting` factories stay.
- **Deprecated:** `forRootAsync({ useValue })`, which emits a `DeprecationWarning` (`OCODA_ES_FOR_ROOT_ASYNC_USE_VALUE`) once; use `forRoot(options)`. Removed in 5.0. `forRootAsync()` without `useFactory`, `useClass` or `useExisting` throws an `EventSourcingConfigurationException` instead of an `Error`.
- **Production warning.** When `NODE_ENV` is `production` and `eventStore` or `snapshotStore` is left out, the module warns that the in-memory store loses everything on restart.
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
