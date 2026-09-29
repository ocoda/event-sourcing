import { EventSourcingErrorCode } from '../event-sourcing-error.js';
import { brandEventSourcingError } from '../internal.js';
import { DomainException } from './domain-error.js';

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
	/** The class name of the id, such as 'UUID' or 'AccountId'. */
	readonly idType?: string;

	constructor(details?: { value?: unknown; idType?: string; reason?: string }, options?: ErrorOptions) {
		super(InvalidIdException.describe(details), undefined, options);
		this.value = details?.value;
		this.idType = details?.idType;
	}

	private static describe(details?: { value?: unknown; idType?: string; reason?: string }): string {
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
