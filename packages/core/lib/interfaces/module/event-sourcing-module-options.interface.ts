import { ModuleMetadata, Type } from '@nestjs/common';
import { InMemoryEventStoreConfig } from '../../integration/event-store';
import { InMemorySnapshotStoreConfig } from '../../integration/snapshot-store';
import { SnapshotStoreConfig } from '../aggregate';
import { EventStoreConfig, IEvent } from '../events';

export interface EventSourcingModuleOptions<
	TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
	TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
> {
	events: Type<IEvent>[];
	eventStore?: TEventStoreConfig;
	snapshotStore?: TSnapshotStoreConfig;
	disableDefaultSerializer?: boolean;
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
	TFactory extends EventSourcingOptionsFactory<
		TEventStoreConfig,
		TSnapshotStoreConfig,
		TOptions
	> = EventSourcingOptionsFactory<TEventStoreConfig, TSnapshotStoreConfig, TOptions>,
> extends Pick<ModuleMetadata, 'imports'> {
	useExisting?: Type<TFactory>;
	useClass?: Type<TFactory>;
	useFactory?: (...args: any[]) => Promise<TOptions> | TOptions;
	inject?: any[];
}
