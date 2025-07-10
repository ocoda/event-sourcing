import {
    Inject,
    Injectable,
    OnModuleInit,
    OnModuleDestroy,
    OnApplicationShutdown,
    OnApplicationBootstrap
} from "@nestjs/common";

import {EVENT_SOURCING_OPTIONS} from "./constants";
import type {EventSourcingModuleOptions} from "./interfaces";

import {EventStore} from "./event-store";
import {SnapshotStore} from "./snapshot-store";

import {ExplorerService} from "./services";


@Injectable()
export class EventSourcingModuleInitializer implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap, OnApplicationShutdown {
    constructor(
        @Inject(EVENT_SOURCING_OPTIONS)
        private readonly options: EventSourcingModuleOptions,
        private readonly eventStore: EventStore,
        private readonly explorerService: ExplorerService, // Placeholder for ExplorerService, which is not defined in the provided code
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

    onApplicationBootstrap(): any {
    }

    onApplicationShutdown(signal?: string): any {
    }
}