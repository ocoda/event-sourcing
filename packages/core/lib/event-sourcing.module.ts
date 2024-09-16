import { DynamicModule, Module, OnModuleInit, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CommandBus } from './command-bus';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventBus } from './event-bus';
import { EventMap } from './event-map';
import { EventStoreProvider, SnapshotStoreProvider, createEventSourcingProviders } from './event-sourcing.providers';
import { EventStore } from './event-store';
import { HandlersLoader } from './handlers.loader';
import { InMemoryEventStoreConfig } from './integration/event-store';
import { InMemorySnapshotStoreConfig } from './integration/snapshot-store';
import {
	EventSourcingModuleAsyncOptions,
	EventSourcingModuleOptions,
	EventSourcingOptionsFactory,
	EventStoreConfig,
	SnapshotStoreConfig,
} from './interfaces';
import { QueryBus } from './query-bus';
import { SnapshotStore } from './snapshot-store';

@Module({})
export class EventSourcingModule implements OnModuleInit {
	/**
	 * Register the module synchronously
	 */
	static forRoot(
		options: EventSourcingModuleOptions<InMemoryEventStoreConfig, InMemorySnapshotStoreConfig>,
	): DynamicModule {
		const providers = [
			...createEventSourcingProviders(options),
			EventMap,
			HandlersLoader,
			CommandBus,
			QueryBus,
			EventBus,
			EventStoreProvider,
			SnapshotStoreProvider,
		];

		return {
			module: EventSourcingModule,
			imports: [DiscoveryModule],
			providers,
			exports: providers,
		};
	}

	/**
	 * Register the module asynchronously
	 */
	static forRootAsync<
		TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	>(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {
		const providers = [
			...EventSourcingModule.createAsyncProviders(options),
			EventMap,
			HandlersLoader,
			CommandBus,
			QueryBus,
			EventBus,
			EventStoreProvider,
			SnapshotStoreProvider,
		];
		return {
			module: EventSourcingModule,
			imports: [DiscoveryModule, ...(options?.imports || [])],
			providers: providers,
			exports: providers,
		};
	}

	private static createAsyncProviders<
		TEventStoreConfig extends EventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig,
	>(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): Provider[] {
		if (options.useExisting || options.useFactory) {
			return [EventSourcingModule.createAsyncOptionsProvider(options)];
		}
		return [
			EventSourcingModule.createAsyncOptionsProvider(options),
			{
				provide: options.useClass,
				useClass: options.useClass,
			},
		];
	}

	private static createAsyncOptionsProvider<
		TEventStoreConfig extends EventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig,
	>(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): Provider {
		if (options.useFactory) {
			return {
				provide: EVENT_SOURCING_OPTIONS,
				useFactory: options.useFactory,
				inject: options.inject || [],
			};
		}
		return {
			provide: EVENT_SOURCING_OPTIONS,
			useFactory: async (optionsFactory: EventSourcingOptionsFactory) =>
				await optionsFactory.createEventSourcingOptions(),
			inject: [options.useExisting || options.useClass],
		};
	}

	constructor(
		private readonly eventStore: EventStore,
		private readonly snapshotStore: SnapshotStore,
	) {}

	async onModuleInit() {
		await Promise.all([this.eventStore.start(), this.snapshotStore.start()]); // TODO: Add error handling
	}

	async onModuleDestroy() {
		await Promise.all([this.eventStore.stop(), this.snapshotStore.stop()]); // TODO: Add error handling
	}
}
