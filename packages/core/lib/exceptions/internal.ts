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
 * A short description of any value for a message: strings quoted, bigints with their `n`, objects by their kind.
 * Never throws and never prints the contents of an object, which may be large or sensitive.
 */
export const describeValue = (value: unknown): string => {
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'bigint':
			return `${value}n`;
		case 'object':
			if (value === null) {
				return 'null';
			}
			return Array.isArray(value) ? 'an array' : 'an object';
		case 'function':
			return 'a function';
		case 'symbol':
			return value.toString();
		default:
			return String(value);
	}
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
