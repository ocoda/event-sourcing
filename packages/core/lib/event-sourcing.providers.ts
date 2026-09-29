import type { InjectionToken, OptionalFactoryDependency, Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EVENT_SOURCING_OPTIONS } from './constants.js';
import { EventBus } from './event-bus.js';
import { EventMap } from './event-map.js';
import { EventStore } from './event-store.js';
import { InMemoryEventStore, type InMemoryEventStoreConfig } from './integration/event-store/index.js';
import { InMemorySnapshotStore, type InMemorySnapshotStoreConfig } from './integration/snapshot-store/index.js';
import type {
	EventSourcingModuleAsyncOptions,
	EventSourcingModuleOptions,
	EventSourcingOptionsFactory,
	EventStoreConfig,
	SnapshotStoreConfig,
} from './interfaces/index.js';
import { SnapshotStore } from './snapshot-store.js';
import { assertEventStoreImplementation } from './stores/implementation-guard.js';
import { isLegacyEventStore } from './stores/legacy-event-store.js';

export const EventStoreProvider = {
	provide: EventStore,
	useFactory: async (eventMap: EventMap, eventBus: EventBus, { eventStore }: EventSourcingModuleOptions) => {
		// The driver options are the rest of the config: the module handles useDefaultPool
		const { driver, useDefaultPool: _, ...options } = eventStore ?? { driver: InMemoryEventStore };
		const store = new driver({ eventMap, publisher: eventBus }, options);
		// INTERIM(H): stores that still override appendEvents run on the legacy path; from 4.0 every store is checked
		if (!isLegacyEventStore(store)) {
			assertEventStoreImplementation(store);
		}
		return store;
	},
	inject: [EventMap, EventBus, EVENT_SOURCING_OPTIONS],
};

export const SnapshotStoreProvider = {
	provide: SnapshotStore,
	useFactory: async ({ snapshotStore }: EventSourcingModuleOptions) => {
		const { driver, ...config } = snapshotStore ?? { driver: InMemorySnapshotStore };
		return new driver(config);
	},
	inject: [EVENT_SOURCING_OPTIONS],
};

/**
 * A utility function for getting the options injection token
 */
export const getOptionsToken = () => EVENT_SOURCING_OPTIONS;

export function createEventStoreProviders() {
	return [EventStoreProvider];
}
export function createSnapshotStoreProviders() {
	return [SnapshotStoreProvider];
}
export function createEventSourcingOptionsProvider<
	TEventStoreConfig extends EventStoreConfig = InMemoryEventStoreConfig,
	TSnapshotStoreConfig extends SnapshotStoreConfig = InMemorySnapshotStoreConfig,
>(options: EventSourcingModuleOptions<TEventStoreConfig, TSnapshotStoreConfig>): Provider[] {
	return [{ provide: EVENT_SOURCING_OPTIONS, useValue: options }];
}

export function createAsyncEventSourcingOptionsProvider<
	TEventStoreConfig extends EventStoreConfig,
	TSnapshotStoreConfig extends SnapshotStoreConfig,
>(options: EventSourcingModuleAsyncOptions<TEventStoreConfig, TSnapshotStoreConfig>): Provider[] {
	// If useValue is provided, we can directly return the provider
	if (options?.useValue) {
		return [
			{
				provide: EVENT_SOURCING_OPTIONS,
				useValue: options.useValue,
			},
		];
	}

	// If useFactory is provided, we can directly return the provider
	if (options?.useFactory) {
		return [
			{
				provide: EVENT_SOURCING_OPTIONS,
				useFactory: options.useFactory,
				inject: options.inject || [],
			},
		];
	}

	// useExisting resolves an options factory that is already provided (e.g. exported by one of the imports)
	if (options?.useExisting) {
		return [
			{
				provide: getOptionsToken(),
				useFactory: async (optionsFactory: EventSourcingOptionsFactory) =>
					await optionsFactory.createEventSourcingOptions(),
				inject: [options.useExisting],
			},
		];
	}

	// useClass instantiates the options factory within the module's context, so its dependencies are resolved from the
	// `imports` and global modules. An options factory that is already provided (e.g. exported by one of the `imports`,
	// which was the only way to make useClass work before) is reused instead of being shadowed by a new instance.
	if (options?.useClass) {
		const { useClass } = options;
		const inject: (InjectionToken | OptionalFactoryDependency)[] = [{ token: useClass, optional: true }, ModuleRef];

		return [
			{
				provide: getOptionsToken(),
				useFactory: async (providedFactory: EventSourcingOptionsFactory | undefined, moduleRef: ModuleRef) => {
					const optionsFactory = providedFactory ?? (await moduleRef.create(useClass));
					return await optionsFactory.createEventSourcingOptions();
				},
				inject,
			},
		];
	}

	throw new Error(
		'Invalid EventSourcingModule.forRootAsync() options: provide one of "useFactory", "useClass", "useExisting" or "useValue".',
	);
}
