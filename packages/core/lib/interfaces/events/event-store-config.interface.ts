import type { EventStoreDriver } from './event-store.interface.js';

export interface EventStoreConfig {
	/**
	 * The event store class. The module constructs it with the store context and the rest of this config, without
	 * `driver` and `useDefaultPool`.
	 */
	driver: EventStoreDriver;
	/**
	 * Creates an event collection with the default pool name ('events').
	 * For multi-tenant setups, you can provide a pool name to separate events with `eventStore.ensureCollection(pool?: IEventPool)`.
	 * @default true
	 */
	useDefaultPool?: boolean;
}
