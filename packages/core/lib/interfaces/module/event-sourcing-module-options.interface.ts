import type { ModuleMetadata, Type } from '@nestjs/common';
import type { InMemoryEventStoreConfig } from '../../integration/event-store/index.js';
import type { InMemorySnapshotStoreConfig } from '../../integration/snapshot-store/index.js';
import type { SnapshotStoreConfig } from '../aggregate/index.js';
import type { EventStoreConfig, IEvent } from '../events/index.js';

export interface EventSourcingModuleOptions<
	TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
	TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
> {
	/**
	 * The events to register in the module globally.
	 * This is optional, as you can also register events in the feature module.
	 */
	events?: Type<IEvent>[];
	eventStore?: TEventStoreConfig;
	snapshotStore?: TSnapshotStoreConfig;
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
	useValue?: TOptions;
	inject?: any[];
}
