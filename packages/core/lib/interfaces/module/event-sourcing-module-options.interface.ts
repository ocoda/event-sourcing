import type { ModuleMetadata, Type } from '@nestjs/common';
import type { InMemoryEventStoreConfig } from '../../integration/event-store/index.js';
import type { InMemorySnapshotStoreConfig } from '../../integration/snapshot-store/index.js';
import type { SnapshotStoreConfig } from '../aggregate/index.js';
import type { EventSerializerFactory, EventStoreConfig, IEvent, IEventSerializer } from '../events/index.js';

export interface EventSourcingModuleOptions<
	TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
	TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
> {
	/**
	 * The events to register in the module globally.
	 * This is optional, as you can also register events in the feature module.
	 */
	events?: Type<IEvent>[];
	/**
	 * The event store: its `driver` class, `useDefaultPool` and the options of the driver. The module strips `driver`
	 * and `useDefaultPool`, creates the store with the rest, connects it and, unless `useDefaultPool` is `false`, creates
	 * the default pool while the application bootstraps. Default: the in-memory store, which loses every event when the
	 * process stops (the module warns about that when `NODE_ENV` is `production`).
	 */
	eventStore?: TEventStoreConfig;
	/**
	 * The snapshot store, configured like the event store. Default: the in-memory store.
	 */
	snapshotStore?: TSnapshotStoreConfig;
	/**
	 * The serializer of every event that has no `@EventSerializer()` of its own. Default: `JsonEventSerializer`.
	 * Events with class-transformer decorators need `ClassTransformerEventSerializer`, from
	 * `@ocoda/event-sourcing/class-transformer`: on the JSON serializer, the application fails to bootstrap for an event
	 * class with decorators, and an append fails for an event that holds an instance of a class with decorators.
	 */
	defaultEventSerializer?: EventSerializerFactory;
	/**
	 * How the `EventBus` publishes the envelopes of an append. Both timeouts are in milliseconds, and `0` disables them.
	 */
	publishing?: {
		/**
		 * How long one call of an event publisher may take before the bus reports a timeout on `deliveryErrors$` and
		 * moves on to the next envelope. Default: 30 000 (30 s).
		 */
		publisherTimeout?: number;
		/**
		 * How long the application's shutdown waits for the publishers and subscribers that are still running
		 * (`EventBus.whenIdle()`) before the stores disconnect. Default: 10 000 (10 s).
		 */
		shutdownTimeout?: number;
	};
}

export interface EventSourcingOptionsFactory<
	TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
	TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	TOptions extends EventSourcingModuleOptions<TEventStoreConfig, TSnapshotStoreConfig> = EventSourcingModuleOptions<
		TEventStoreConfig,
		TSnapshotStoreConfig
	>,
> {
	createEventSourcingOptions: () => Promise<TOptions> | TOptions;
}

export interface EventSourcingModuleAsyncOptions<
	TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
	TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	TOptions extends EventSourcingModuleOptions<TEventStoreConfig, TSnapshotStoreConfig> = EventSourcingModuleOptions<
		TEventStoreConfig,
		TSnapshotStoreConfig
	>,
	TFactory extends EventSourcingOptionsFactory<TEventStoreConfig, TSnapshotStoreConfig, TOptions> =
		EventSourcingOptionsFactory<TEventStoreConfig, TSnapshotStoreConfig, TOptions>,
> extends Pick<ModuleMetadata, 'imports'> {
	useExisting?: Type<TFactory>;
	useClass?: Type<TFactory>;
	useFactory?: (...args: any[]) => Promise<TOptions> | TOptions;
	/**
	 * @deprecated Use `EventSourcingModule.forRoot(options)`, which it comes down to. Removed in 5.0.
	 */
	useValue?: TOptions;
	inject?: any[];
}

/**
 * The options of `EventSourcingModule.forFeature()`.
 */
export interface EventSourcingFeatureOptions extends Pick<ModuleMetadata, 'imports'> {
	/**
	 * The events of the feature module. They are registered in the applications that import it.
	 */
	events?: Type<IEvent>[];
	/**
	 * The event serializers (classes decorated with `@EventSerializer()`) of the feature module's events. The feature
	 * module provides them, with their dependencies from `imports`.
	 */
	serializers?: Type<IEventSerializer>[];
}
