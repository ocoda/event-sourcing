import type { EventStoreCapabilities } from '../interfaces/index.js';

/**
 * The guarantees of an event store that doesn't declare them: atomic appends, no headers and a best-effort global order.
 */
export const DEFAULT_EVENT_STORE_CAPABILITIES: Readonly<Required<EventStoreCapabilities>> = Object.freeze({
	atomicAppend: true,
	headers: false,
	globalOrder: 'best-effort',
});

/**
 * The capabilities of an event store with the defaults filled in. A flag the store leaves out, or sets to a value of
 * the wrong type, gets its default.
 */
export const resolveCapabilities = (capabilities?: EventStoreCapabilities | null): Required<EventStoreCapabilities> => {
	const { atomicAppend, headers, globalOrder } = capabilities ?? {};
	return {
		atomicAppend: typeof atomicAppend === 'boolean' ? atomicAppend : DEFAULT_EVENT_STORE_CAPABILITIES.atomicAppend,
		headers: typeof headers === 'boolean' ? headers : DEFAULT_EVENT_STORE_CAPABILITIES.headers,
		globalOrder:
			globalOrder === 'gap-safe' || globalOrder === 'best-effort'
				? globalOrder
				: DEFAULT_EVENT_STORE_CAPABILITIES.globalOrder,
	};
};
