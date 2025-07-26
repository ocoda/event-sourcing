import {
	type DynamicModule,
	Logger,
	Module,
	type OnApplicationBootstrap,
	type OnModuleDestroy,
	type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import type {
	EventSourcingModuleAsyncOptions,
	EventSourcingModuleOptions,
	EventStoreConfig,
	SnapshotStoreConfig,
} from './interfaces';

import { CommandBus } from './command-bus';
import { EventBus } from './event-bus';
import { EventMap } from './event-map';
import { QueryBus } from './query-bus';

// biome-ignore lint/style/useImportType: used in di
import { EventStore } from './event-store';
// biome-ignore lint/style/useImportType: used in di
import { SnapshotStore } from './snapshot-store';

import { InjectEventSourcingOptions } from './decorators';
import { ExplorerService } from './services';

import {
	createAsyncEventSourcingOptionsProvider,
	createEventSourcingOptionsProvider,
	createEventStoreProviders,
	createSnapshotStoreProviders,
} from './event-sourcing.providers';

import type { InMemoryEventStoreConfig, InMemorySnapshotStoreConfig } from './integration';

@Module({})
export class EventSourcingFeatureModule {}

@Module({})
export class EventSourcingCoreModule implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap {
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
			providers: [ExplorerService, ...exportedProviders],
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
			providers: [ExplorerService, ...exportedProviders],
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
	async onModuleDestroy() {
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
		this.eventMap.registerSerializers(events, eventSerializers);
		this._logger.debug('Event handlers registered successfully.');

		this.eventStore.publish = this.eventBus.publish;
	}
}
