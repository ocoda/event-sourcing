import type { InjectionToken, OptionalFactoryDependency, Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventStore } from './event-store';
import { InMemoryEventStore, type InMemoryEventStoreConfig } from './integration/event-store';
import { InMemorySnapshotStore, type InMemorySnapshotStoreConfig } from './integration/snapshot-store';
import type {
	EventSourcingModuleAsyncOptions,
	EventSourcingModuleOptions,
	EventSourcingOptionsFactory,
	EventStoreConfig,
	SnapshotStoreConfig,
} from './interfaces';
import { SnapshotStore } from './snapshot-store';

export const EventStoreProvider = {
	provide: EventStore,
	useFactory: async (eventMap: EventMap, { eventStore }: EventSourcingModuleOptions) => {
		const { driver, ...config } = eventStore ?? { driver: InMemoryEventStore };
		return new driver(eventMap, config);
	},
	inject: [EventMap, EVENT_SOURCING_OPTIONS],
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
