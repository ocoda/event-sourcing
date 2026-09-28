import type { InjectionToken, OptionalFactoryDependency, Provider } from '@nestjs/common';
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
	if (!options || !(options.useValue || options.useFactory || options.useExisting || options.useClass)) {
		throw new Error(
			'Invalid EventSourcingModule.forRootAsync() options: provide one of "useFactory", "useClass", "useExisting" or "useValue".',
		);
	}

	// If useValue is provided, we can directly return the provider
	if (options.useValue) {
		return [
			{
				provide: EVENT_SOURCING_OPTIONS,
				useValue: options.useValue,
			},
		];
	}

	// If useFactory is provided, we can directly return the provider
	if (options.useFactory) {
		return [
			{
				provide: EVENT_SOURCING_OPTIONS,
				useFactory: options.useFactory,
				inject: options.inject || [],
			},
		];
	}

	const inject: (InjectionToken | OptionalFactoryDependency)[] = [];
	const providers: Provider[] = [];

	if (options.useExisting) {
		// useExisting resolves an options factory that is already provided (e.g. exported by one of the imports)
		inject.push(options.useExisting);
	} else if (options.useClass) {
		// useClass instantiates the options factory, so it needs to be registered as a provider
		inject.push(options.useClass);
		providers.push({ provide: options.useClass, useClass: options.useClass });
	}

	return [
		{
			provide: getOptionsToken(),
			useFactory: async (optionsFactory: EventSourcingOptionsFactory) =>
				await optionsFactory.createEventSourcingOptions(),
			inject,
		},
		...providers,
	];
}
