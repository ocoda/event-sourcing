import type { Type } from '@nestjs/common';
import type { EventStoreDriver } from './event-store.interface';

export interface EventStoreConfig {
	driver: Type<EventStoreDriver>;
	/**
	 * Creates an event collection with the default pool name ('events').
	 * For multi-tenant setups, you can provide a pool name to separate events with `eventStore.ensureCollection(pool?: IEventPool)`.
	 * @default true
	 */
	useDefaultPool?: boolean;
}
