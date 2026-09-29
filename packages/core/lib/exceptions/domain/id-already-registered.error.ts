import type { Id } from '../../models/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Signals that an id is already taken.
 */
export class IdAlreadyRegisteredException extends EventSourcingError {
	override readonly name = 'IdAlreadyRegisteredException';
	readonly code = EventSourcingErrorCode.IdAlreadyRegistered;
	/** The value of the id. */
	readonly id: string;

	constructor(details: { id: Id | string }, options?: ErrorOptions) {
		const id = typeof details?.id === 'string' ? details.id : details?.id?.value;
		super(`Id ${id} already taken.`, options);
		this.id = id;
	}

	/** @deprecated Use `new IdAlreadyRegisteredException({ id })`. Removed in 5.0. */
	public static withId(id: Id): IdAlreadyRegisteredException {
		return new IdAlreadyRegisteredException({ id });
	}
}
