import type { EventStore } from '../event-store.js';
import { InvalidEventStoreImplementationException } from '../exceptions/index.js';

/**
 * Marks `EventStore.prototype`, where the walk up a store's prototype chain stops. A `Symbol.for` symbol, so that a
 * store built on a second copy of the package is checked up to that copy's base class.
 * @internal
 */
export const EVENT_STORE_BASE = Symbol.for('@ocoda/event-sourcing/EventStore');

/**
 * The methods that `EventStore` implements for every store. They validate appends, check versions, serialize and
 * publish, so a store implements the driver methods (`getStreamVersion`, `persistEvents`, ...) instead.
 */
export const EVENT_STORE_TEMPLATE_METHODS = ['appendEvents', 'getEvent', 'getEvents'] as const;

/**
 * The template methods that the store overrides: those that are own properties of the store (a class field, since
 * class fields use define semantics) or of a prototype between the store and `EventStore.prototype`.
 */
export const overriddenTemplateMethods = (store: object): string[] => {
	const overridden = new Set<string>();
	const collect = (target: object) => {
		for (const method of EVENT_STORE_TEMPLATE_METHODS) {
			if (Object.hasOwn(target, method)) {
				overridden.add(method);
			}
		}
	};

	collect(store);
	for (
		let prototype = Object.getPrototypeOf(store);
		prototype !== null && !Object.hasOwn(prototype, EVENT_STORE_BASE);
		prototype = Object.getPrototypeOf(prototype)
	) {
		collect(prototype);
	}
	return EVENT_STORE_TEMPLATE_METHODS.filter((method) => overridden.has(method));
};

/**
 * Checks that an event store doesn't override `appendEvents`, `getEvent` or `getEvents`, which `EventStore` implements
 * for every store. Overriding `persistEvents` (and calling `super`) is the way to decorate appends.
 *
 * The module runs it when it creates the event store, so an override fails the bootstrap.
 *
 * @throws InvalidEventStoreImplementationException naming the overridden methods
 */
export const assertEventStoreImplementation = (store: EventStore<unknown>): void => {
	const methods = overriddenTemplateMethods(store);
	if (methods.length > 0) {
		throw new InvalidEventStoreImplementationException({ store: store?.constructor?.name ?? 'unknown', methods });
	}
};
