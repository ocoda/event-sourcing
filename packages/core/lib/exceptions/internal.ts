/**
 * Internal helpers of the exceptions, not exported from the package.
 */

/**
 * Registered with `Symbol.for`, so errors from a second copy of the package (a duplicated install, or a bundle that
 * inlined it) are still recognised.
 */
export const EVENT_SOURCING_ERROR = Symbol.for('@ocoda/event-sourcing/EventSourcingError');

/**
 * Brands a prototype as an event-sourcing error: the base class, and the one library error that keeps its 3.x parent
 * (`InvalidIdException extends DomainException`).
 */
export const brandEventSourcingError = (prototype: object): void => {
	Object.defineProperty(prototype, EVENT_SOURCING_ERROR, { value: true });
};

/**
 * The name to show for a class, an instance of it or a name. Never throws, so a constructor given `undefined` still
 * produces an error.
 */
export const nameOf = (target: unknown): string | undefined => {
	switch (typeof target) {
		case 'string':
			return target || undefined;
		case 'function':
			return target.name || undefined;
		case 'object':
			return (target?.constructor as { name?: string } | undefined)?.name || undefined;
		default:
			return undefined;
	}
};
