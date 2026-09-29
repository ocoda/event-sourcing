import {
	type DynamicModule,
	Inject,
	Logger,
	Module,
	type OnApplicationBootstrap,
	type OnApplicationShutdown,
	type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import type {
	EventSourcingModuleAsyncOptions,
	EventSourcingModuleOptions,
	EventStoreConfig,
	SnapshotStoreConfig,
} from './interfaces/index.js';

import { CommandBus } from './command-bus.js';
import { EventBus } from './event-bus.js';
import { EventMap } from './event-map.js';
import { QueryBus } from './query-bus.js';

import { EventStore } from './event-store.js';
import { SnapshotStore } from './snapshot-store.js';

import { InjectEventSourcingOptions } from './decorators/index.js';
import {
	CLASS_TRANSFORMER_DECORATORS,
	type ClassTransformerDecoratorsOf,
	classTransformerDecoratorsProvider,
} from './helpers/class-transformer-decorators.js';
import { ExplorerService } from './services/index.js';

import {
	createAsyncEventSourcingOptionsProvider,
	createEventSourcingOptionsProvider,
	createEventStoreProviders,
	createSnapshotStoreProviders,
} from './event-sourcing.providers.js';

import type { InMemoryEventStoreConfig, InMemorySnapshotStoreConfig } from './integration/index.js';

@Module({})
export class EventSourcingFeatureModule {}

@Module({})
export class EventSourcingCoreModule implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
	private _logger = new Logger(EventSourcingCoreModule.name);

	constructor(
		@InjectEventSourcingOptions()
		private readonly options: EventSourcingModuleOptions,
		private readonly queryBus: QueryBus,
		private readonly eventBus: EventBus,
		private readonly eventMap: EventMap,
		private readonly commandBus: CommandBus,
		private readonly eventStore: EventStore,
		private readonly snapshotStore: SnapshotStore,
		private readonly explorerService: ExplorerService,
		@Inject(CLASS_TRANSFORMER_DECORATORS)
		private readonly classTransformerDecoratorsOf?: ClassTransformerDecoratorsOf,
	) {}

	static forRoot<
		TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	>(options: EventSourcingModuleOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {
		// Create providers based on the provided options
		const exportedProviders = [
			EventBus,
			EventMap,
			QueryBus,
			CommandBus,
			...createEventStoreProviders(),
			...createSnapshotStoreProviders(),
			...createEventSourcingOptionsProvider(options),
		];

		return {
			global: true,
			module: EventSourcingCoreModule,
			imports: [DiscoveryModule],
			providers: [ExplorerService, classTransformerDecoratorsProvider, ...exportedProviders],
			exports: [...exportedProviders],
		};
	}
	static forRootAsync<
		TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
		TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
	>(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {
		const exportedProviders = [
			EventBus,
			EventMap,
			QueryBus,
			CommandBus,
			...createEventStoreProviders(),
			...createSnapshotStoreProviders(),
			...createAsyncEventSourcingOptionsProvider(options),
		];

		return {
			global: true,
			module: EventSourcingCoreModule,
			imports: [DiscoveryModule, ...(options?.imports || [])],
			providers: [ExplorerService, classTransformerDecoratorsProvider, ...exportedProviders],
			exports: [...exportedProviders],
		};
	}

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
	/**
	 * Disconnects the stores once the application has shut down. Nest runs `onModuleDestroy` first and
	 * `beforeApplicationShutdown` after it, where the `EventBus` waits for the publishers and subscribers that are still
	 * running; disconnecting in `onModuleDestroy` would pull the stores from under them.
	 */
	async onApplicationShutdown() {
		const disconnects = await Promise.allSettled([this.eventStore.disconnect(), this.snapshotStore.disconnect()]);
		for (const disconnect of disconnects) {
			if (disconnect.status === 'rejected') {
				this._logger.error('Error while disconnecting from event store or snapshot store', disconnect.reason);
			}
		}
	}

	onApplicationBootstrap(): any {
		const { events, queries, commands, eventPublishers, eventSerializers, eventSubscribers } =
			this.explorerService.explore();

		// Register the handlers
		this._logger.debug('Registering event handlers...');
		this.queryBus.register(queries);
		this.commandBus.register(commands);
		this.eventBus.registerPublishers(eventPublishers);
		this.eventBus.registerSubscribers(eventSubscribers);
		// Fails the bootstrap for an event with class-transformer decorators that would get the JSON serializer
		this.eventMap.registerSerializers(events, eventSerializers, {
			defaultSerializer: this.options.defaultEventSerializer,
			classTransformerDecoratorsOf: this.classTransformerDecoratorsOf,
		});
		this._logger.debug('Event handlers registered successfully.');
	}
}
