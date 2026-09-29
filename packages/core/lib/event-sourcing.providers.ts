import { type FactoryProvider, Logger, type Provider } from '@nestjs/common';
import { CommandBus } from './command-bus.js';
import { EVENT_SOURCING_OPTIONS } from './constants.js';
import { EventBus } from './event-bus.js';
import { EventMap } from './event-map.js';
import { EventStore } from './event-store.js';
import { EventSourcingConfigurationException } from './exceptions/index.js';
import { describeValue } from './exceptions/internal.js';
import { classTransformerDecoratorsProvider } from './helpers/class-transformer-decorators.js';
import { InMemoryEventStore } from './integration/event-store/index.js';
import { InMemorySnapshotStore } from './integration/snapshot-store/index.js';
import type { EventSourcingModuleOptions } from './interfaces/index.js';
import { QueryBus } from './query-bus.js';
import { EventSourcingRegistrar } from './registration/registrar.js';
import { EVENT_SOURCING_REGISTRATION } from './registration/registration.js';
import { SnapshotStore } from './snapshot-store.js';
import { assertEventStoreImplementation } from './stores/implementation-guard.js';

const logger = new Logger('EventSourcingModule');

type Store = { connect(): Promise<void>; disconnect(): Promise<void>; ensureCollection(): Promise<unknown> };

/**
 * The store's driver class; anything else fails the bootstrap with a configuration issue.
 */
const assertDriver = (driver: unknown, option: 'eventStore' | 'snapshotStore'): void => {
	if (typeof driver !== 'function') {
		throw new EventSourcingConfigurationException({
			issues: [
				{
					kind: 'invalid-options',
					message: `${option}.driver must be the class of the store, such as ${option === 'eventStore' ? 'PostgresEventStore' : 'PostgresSnapshotStore'}, got ${describeValue(driver)}.`,
				},
			],
		});
	}
};

/**
 * Warns when production runs on an in-memory store because the option was left out: it loses everything on restart.
 */
const warnIfImplicitInMemory = (config: unknown, option: 'eventStore' | 'snapshotStore'): void => {
	if (config === undefined && process.env.NODE_ENV === 'production') {
		logger.warn(
			option === 'eventStore'
				? 'No eventStore is configured, so the module uses the in-memory event store, which loses every event when the process stops. Configure eventStore with the driver of your database.'
				: 'No snapshotStore is configured, so the module uses the in-memory snapshot store, which loses the snapshots when the process stops (the aggregates are then loaded from their events). If you use snapshots, configure snapshotStore with the driver of your database.',
		);
	}
};

/**
 * Connects a store and creates its default pool, so that a wrong connection or a table that needs a migration fails
 * the bootstrap. A store that fails is disconnected, so it leaves no connection open.
 */
const open = async (store: Store, createDefaultPool: boolean, option: 'eventStore' | 'snapshotStore') => {
	try {
		await store.connect();
		if (createDefaultPool) {
			await store.ensureCollection();
		}
	} catch (error) {
		try {
			await store.disconnect();
		} catch (disconnectError) {
			logger.error(`Failed to disconnect the ${option} after it failed to start`, disconnectError);
		}
		throw error;
	}
};

/**
 * Creates the event store from `eventStore` (the in-memory store by default): the driver gets the store context and the
 * rest of the config as its options, without `driver` and `useDefaultPool` (D32). A store that overrides a template
 * method fails the bootstrap (D8). Then it connects and, unless `useDefaultPool` is `false`, creates the default pool.
 */
export const EventStoreProvider: FactoryProvider<EventStore> = {
	provide: EventStore,
	useFactory: async (options: EventSourcingModuleOptions | undefined, eventMap: EventMap, eventBus: EventBus) => {
		warnIfImplicitInMemory(options?.eventStore, 'eventStore');
		const { driver, useDefaultPool, ...driverOptions } = options?.eventStore ?? { driver: InMemoryEventStore };
		assertDriver(driver, 'eventStore');
		const store = new driver({ eventMap, publisher: eventBus }, driverOptions);
		assertEventStoreImplementation(store);
		await open(store, useDefaultPool !== false, 'eventStore');
		return store;
	},
	inject: [EVENT_SOURCING_OPTIONS, EventMap, EventBus],
};

/**
 * Creates the snapshot store from `snapshotStore` (the in-memory store by default), like the event store but without
 * the context: the driver gets the config without `driver` and `useDefaultPool`.
 *
 * It starts after the event store, which it injects for that reason: when the event store fails, Nest doesn't create
 * the snapshot store, and when the snapshot store fails, the event store is disconnected again. Either way a failed
 * bootstrap leaves no connection open.
 */
export const SnapshotStoreProvider: FactoryProvider<SnapshotStore> = {
	provide: SnapshotStore,
	useFactory: async (options: EventSourcingModuleOptions | undefined, eventStore: EventStore) => {
		try {
			warnIfImplicitInMemory(options?.snapshotStore, 'snapshotStore');
			const { driver, useDefaultPool, ...driverOptions } = options?.snapshotStore ?? {
				driver: InMemorySnapshotStore,
			};
			assertDriver(driver, 'snapshotStore');
			const store = new driver(driverOptions);
			await open(store, useDefaultPool !== false, 'snapshotStore');
			return store;
		} catch (error) {
			try {
				await eventStore.disconnect();
			} catch (disconnectError) {
				logger.error('Failed to disconnect the eventStore after the snapshotStore failed to start', disconnectError);
			}
			throw error;
		}
	},
	inject: [EVENT_SOURCING_OPTIONS, EventStore],
};

/**
 * The providers of the module, besides the options.
 */
export const createCoreProviders = (): Provider[] => [
	EventMap,
	EventBus,
	CommandBus,
	QueryBus,
	{ provide: EVENT_SOURCING_REGISTRATION, useClass: EventSourcingRegistrar },
	// class-transformer's metadata storage, loaded before the registrar is created (ADR 0001 §6)
	classTransformerDecoratorsProvider,
	EventStoreProvider,
	SnapshotStoreProvider,
];

/**
 * What the module exports to the whole application (it is global).
 */
export const CORE_EXPORTS = [
	EVENT_SOURCING_OPTIONS,
	EventMap,
	EventBus,
	CommandBus,
	QueryBus,
	EventStore,
	SnapshotStore,
];
