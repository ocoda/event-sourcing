import {
    DiscoveryModule
} from "@nestjs/core";
import {
    Logger,
    Module,
    OnModuleInit,
    OnModuleDestroy,
    OnApplicationShutdown,
    OnApplicationBootstrap,
    type DynamicModule,
} from "@nestjs/common";

import type {
    EventStoreConfig,
    SnapshotStoreConfig,
    EventSourcingModuleOptions,
    EventSourcingModuleAsyncOptions,
} from "./interfaces";

import {QueryBus} from "./query-bus";
import {EventMap} from "./event-map";
import {EventBus} from "./event-bus";
import {CommandBus} from "./command-bus";

import {EventStore} from "./event-store";
import {SnapshotStore} from "./snapshot-store";

import {ExplorerService} from "./services";
import {InjectEventSourcingOptions} from "./decorators";

import type {
    InMemoryEventStoreConfig,
    InMemorySnapshotStoreConfig
} from "./integration";
import {
    createEventStoreProviders,
    createSnapshotStoreProviders,
    createEventSourcingOptionsProvider,
    createAsyncEventSourcingOptionsProvider
} from './event-sourcing.providers';

@Module({})
export class EventSourcingFeatureModule {

}

@Module({

})
export class EventSourcingCoreModule implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap, OnApplicationShutdown {

    private _logger = new Logger(EventSourcingCoreModule.name);

    // noinspection JSUnusedLocalSymbols
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
    ) {

    }

    // region Module Configuration
    static forRoot
    <
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
            global : true,
            module: EventSourcingCoreModule,
            imports : [
                DiscoveryModule
            ],
            providers: [
                ExplorerService,
                ...exportedProviders,
            ],
            exports: [
                ...exportedProviders
            ],
        };
    }
    static forRootAsync<
        TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
        TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
    >(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): DynamicModule {
        // Create providers based on the provided options
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
            global : true,
            module: EventSourcingCoreModule,
            imports : [
                DiscoveryModule,
                ...(options?.imports || [])
            ],
            providers: [
                ExplorerService,
                ...exportedProviders,
            ],
            exports: [
                ...exportedProviders
            ],
        };
    }
    // endregion

    // region Lifecycle Hooks
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

    onApplicationBootstrap(): any {
        const {
            events,
            queries,
            commands,
            eventPublishers,
            eventSerializers,
            eventSubscribers,
        } = this.explorerService.explore();

        // Register the handlers
        this._logger.debug("Registering event handlers...");
        this.queryBus.register(queries);
        this.commandBus.register(commands);
        this.eventBus.registerPublishers(eventPublishers);
        this.eventBus.registerSubscribers(eventSubscribers);
        this.eventMap.registerSerializers(events, eventSerializers);
        this._logger.debug("Event handlers registered successfully.");

        // some "magic"
        this.eventStore.publish = this.eventBus.publish;
    }

    onApplicationShutdown(signal?: string): any {
    }

    // endregion

}