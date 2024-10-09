import type { Id } from '../../models';

export class IdNotFoundException extends Error {
	/**
	 * Creates an instance of IdNotFoundException with the provided id.
	 *
	 * @param {Id} id - The id that was not found.
	 * @returns {IdNotFoundException} An instance of IdNotFoundException.
	 */
	public static withId(id: Id): IdNotFoundException {
		return new IdNotFoundException(`Id ${id.value} not found.`);
	}
}
