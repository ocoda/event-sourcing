import {
	Type,
	Module,
	type DynamicModule,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import {
	EventRegistry
} from './registries'
import type {
	InMemoryEventStoreConfig,
	InMemorySnapshotStoreConfig
} from './integration';
import type {
	IEvent,
	EventStoreConfig,
	SnapshotStoreConfig,
	EventSourcingModuleOptions,
	EventSourcingModuleAsyncOptions,
} from './interfaces';
import {
	EventSourcingCoreModule,
	EventSourcingFeatureModule
} from './event-sourcing.core.module'

@Module({})
export class EventSourcingModule  {
	/**
	 * Register the feature module synchronously
	 */
	static forFeature(options?: {events: Type<IEvent>[] }): DynamicModule {
		// prepare the providers
		const providers = [];

		// register the events
		EventRegistry.register(...(options?.events ?? []));

		return {
			module: EventSourcingFeatureModule,
			imports: [DiscoveryModule],
			providers : [
				...providers
			],
			exports: [
				...providers
			],
		};
	}

	/**
	 * Register the module synchronously
	 */
	static forRoot<
		TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	>(options: EventSourcingModuleOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {

		// custom providers on top
		const providers = [];

		return {
			module: EventSourcingModule,
			imports: [
				EventSourcingCoreModule.forRoot(options),
			],
			exports: [
				...providers,
				EventSourcingCoreModule
			],
			providers : providers,
		};
	}

	/**
	 * Register the module asynchronously
	 */
	static forRootAsync<
		TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	>(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {

		const providers = [];

		return {
			module: EventSourcingModule,
			imports: [
				DiscoveryModule,
				EventSourcingCoreModule.forRootAsync(options),
			],
			exports: [
				...providers,
				EventSourcingCoreModule
			],
			providers : providers,
		};
	}

}
