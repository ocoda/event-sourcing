import type { Id } from '../../models';

export class IdAlreadyRegisteredException extends Error {
	/**
	 * Creates an instance of the IdAlreadyRegisteredException with the provided id.
	 *
	 * @param {Id} id - The id that is already registered.
	 * @returns {IdAlreadyRegisteredException} An instance of the IdAlreadyRegisteredException.
	 */
	public static withId(id: Id): IdAlreadyRegisteredException {
		return new IdAlreadyRegisteredException(`Id ${id.value} already taken.`);
	}
}
