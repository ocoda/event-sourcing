import { type DynamicModule, Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CommandBus } from './command-bus';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventBus } from './event-bus';
import { EventMap } from './event-map';
import { EventStoreProvider, SnapshotStoreProvider, createEventSourcingProviders } from './event-sourcing.providers';
// biome-ignore lint/style/useImportType: <explanation>
import { EventStore } from './event-store';
import { HandlersLoader } from './handlers.loader';
import type { InMemoryEventStoreConfig, InMemorySnapshotStoreConfig } from './integration';
import type {
	EventSourcingModuleAsyncOptions,
	EventSourcingModuleOptions,
	EventSourcingOptionsFactory,
	EventStoreConfig,
	SnapshotStoreConfig,
} from './interfaces';
import { QueryBus } from './query-bus';
// biome-ignore lint/style/useImportType: DI
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
		@Inject(EVENT_SOURCING_OPTIONS) private readonly options: EventSourcingModuleOptions,
		private readonly eventStore: EventStore,
		private readonly snapshotStore: SnapshotStore,
	) {}

	async onModuleInit() {
		const createDefaultEventPool = this.options.eventStore?.useDefaultPool ?? true;
		const createDefaultSnapshotPool = this.options.snapshotStore?.useDefaultPool ?? true;

		const loadConnections = [this.eventStore.connect(), this.snapshotStore.connect()];
		await Promise.all(loadConnections);

		const loadCollections = [
			createDefaultEventPool && this.eventStore.ensureCollection(),
			createDefaultSnapshotPool && this.snapshotStore.ensureCollection(),
		];
		await Promise.all(loadCollections);
	}

	async onModuleDestroy() {
		await Promise.all([this.eventStore.disconnect(), this.snapshotStore.disconnect()]); // TODO: Add error handling
	}
}
