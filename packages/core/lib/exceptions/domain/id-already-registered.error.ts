import type { Id } from '../../models';

export class IdAlreadyRegisteredError extends Error {
	/**
	 * Creates an instance of the IdAlreadyRegisteredError with the provided id.
	 *
	 * @param {Id} id - The id that is already registered.
	 * @returns {IdAlreadyRegisteredError} An instance of the IdAlreadyRegisteredError.
	 */
	public static withId(id: Id): IdAlreadyRegisteredError {
		return new IdAlreadyRegisteredError(`Id ${id.value} already taken.`);
	}
}
