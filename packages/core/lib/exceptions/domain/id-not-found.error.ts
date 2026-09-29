import type { Id } from '../../models/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Signals that nothing exists with an id.
 */
export class IdNotFoundException extends EventSourcingError {
	override readonly name = 'IdNotFoundException';
	readonly code = EventSourcingErrorCode.IdNotFound;
	/** The value of the id. */
	readonly id: string;

	constructor(details: { id: Id | string }, options?: ErrorOptions) {
		const id = typeof details?.id === 'string' ? details.id : details?.id?.value;
		super(`Id ${id} not found.`, options);
		this.id = id;
	}

	/** @deprecated Use `new IdNotFoundException({ id })`. Removed in 5.0. */
	public static withId(id: Id): IdNotFoundException {
		return new IdNotFoundException({ id });
	}
}
