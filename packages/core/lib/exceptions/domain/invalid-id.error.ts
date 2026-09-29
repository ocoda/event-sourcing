import type { Id } from '../../models/index.js';
import { EventSourcingErrorCode } from '../event-sourcing-error.js';
import { brandEventSourcingError } from '../internal.js';
import { DomainException } from './domain-error.js';

interface InvalidIdDetails {
	/** The value the id was created from. */
	value?: unknown;
	/** The class name of the id class that rejected the value. */
	idType?: string;
	/** Replaces the default message. */
	reason?: string;
}

/**
 * Thrown when an id is created from an empty or malformed value.
 *
 * Unlike the other library errors it still extends `DomainException`, as in 3.x, so exception filters that map domain
 * errors to a 4xx response keep catching it. It is an `EventSourcingError` all the same: `isEventSourcingError()` and
 * `instanceof EventSourcingError` recognise it, and it has a `code`.
 */
export class InvalidIdException extends DomainException {
	override readonly name = 'InvalidIdException';
	readonly code = EventSourcingErrorCode.InvalidId;
	/** The value the id was created from. */
	readonly value?: unknown;
	/** The class name of the id class the value was given to, such as 'AccountId', 'UUID' or 'ULID'. */
	readonly idType?: string;

	constructor(details?: InvalidIdDetails, options?: ErrorOptions);
	/**
	 * @deprecated The 3.x form, kept for subclasses that call `super(message, id)`. Pass
	 * `{ value, idType, reason: message }` instead. Removed in 5.0.
	 */
	constructor(message: string, id?: Id, options?: ErrorOptions);
	constructor(details?: InvalidIdDetails | string, idOrOptions?: Id | ErrorOptions, options?: ErrorOptions) {
		const positional = typeof details === 'string';
		super(
			positional ? details : InvalidIdException.describe(details),
			positional ? (idOrOptions as Id | undefined) : undefined,
			positional ? options : (idOrOptions as ErrorOptions | undefined),
		);
		if (!positional) {
			this.value = details?.value;
			this.idType = details?.idType;
		}
	}

	private static describe(details?: InvalidIdDetails): string {
		if (details?.reason) {
			return details.reason;
		}
		if (details?.value === undefined || details.value === null || details.value === '') {
			return `An id value is required${details?.idType ? ` for ${details.idType}` : ''}.`;
		}
		return `'${String(details.value)}' is not a valid ${details.idType ?? 'id'}.`;
	}

	/** @deprecated Use `new InvalidIdException({ value, idType })`. Removed in 5.0. */
	public static becauseInvalid(uuid: string): InvalidIdException {
		return new InvalidIdException({ value: uuid, idType: 'UUID' });
	}

	/** @deprecated Use `new InvalidIdException({ idType })`. Removed in 5.0. */
	public static becauseEmpty(): InvalidIdException {
		return new InvalidIdException();
	}

	/** @deprecated Use `new InvalidIdException({ value, idType, reason })`. Removed in 5.0. */
	public static because(cause: string): DomainException {
		return new InvalidIdException({ reason: cause });
	}
}

brandEventSourcingError(InvalidIdException.prototype);
