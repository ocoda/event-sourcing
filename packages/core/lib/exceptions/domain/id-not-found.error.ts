import { Id } from '../../models';

export class IdNotFoundError extends Error {
	public static withId(id: Id): IdNotFoundError {
		return new IdNotFoundError(`Id ${id.value} not found.`);
	}
}
