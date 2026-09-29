import type { EventStore } from '../../event-store.js';
import type { EventStoreContext } from './event-store-context.interface.js';

/**
 * An event store class, as `EventStoreConfig.driver` takes it: the module constructs it with the store context and the
 * driver options (the store config without `driver` and `useDefaultPool`).
 */
export type EventStoreDriver<TOptions = any> = new (
	context: EventStoreContext,
	options: TOptions,
) => EventStore<TOptions>;
