import type { Id } from '../../models';

export class IdNotFoundError extends Error {
	/**
	 * Creates an instance of IdNotFoundError with the provided id.
	 *
	 * @param {Id} id - The id that was not found.
	 * @returns {IdNotFoundError} An instance of IdNotFoundError.
	 */
	public static withId(id: Id): IdNotFoundError {
		return new IdNotFoundError(`Id ${id.value} not found.`);
	}
}
