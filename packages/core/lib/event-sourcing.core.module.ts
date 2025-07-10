import {
    DiscoveryModule
} from "@nestjs/core";
import {
    Global,
    Module,
    OnModuleInit,
    OnModuleDestroy,
    OnApplicationShutdown,
    OnApplicationBootstrap, type DynamicModule, type Provider, type InjectionToken, type OptionalFactoryDependency
} from "@nestjs/common";

import type {
    EventStoreConfig,
    SnapshotStoreConfig,
    EventSourcingModuleOptions,
    EventSourcingModuleAsyncOptions, EventSourcingOptionsFactory
} from "./interfaces";

import {QueryBus} from "./query-bus";
import {EventMap} from "./event-map";
import {EventBus} from "./event-bus";
import {CommandBus} from "./command-bus";

import {EventStore} from "./event-store";
import {SnapshotStore} from "./snapshot-store";

import {ExplorerService} from "./services";
import {InjectEventSourcingOptions} from "./decorators";
import {EVENT_SOURCING_OPTIONS} from "./constants";

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

@Module({})
export class EventSourcingCoreModule implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap, OnApplicationShutdown {

    constructor(
        @InjectEventSourcingOptions()
        private readonly options: EventSourcingModuleOptions,
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
            module: EventSourcingCoreModule,
            // global : true,
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
            module: EventSourcingCoreModule,
            // global : true,
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

    private static createAsyncProviders<
        TEventStoreConfig extends EventStoreConfig,
        TSnapshotStoreConfig extends SnapshotStoreConfig
    >(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): Provider[] {
        if (options.useExisting || options.useFactory) {
            return [
                createAsyncEventSourcingOptionsProvider(options)
            ];
        }
        const providers = [
            createAsyncEventSourcingOptionsProvider(options)
        ];

        if (options.useClass) {
            providers.push({
                provide: options.useClass,
                useClass: options.useClass,
            });
        }

        return providers;
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
    }

    onApplicationShutdown(signal?: string): any {
    }
    // endregion
}