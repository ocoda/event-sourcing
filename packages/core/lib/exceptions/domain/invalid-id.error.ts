import { DomainError } from './domain-error';

export class InvalidIdError extends DomainError {
	/**
	 * Creates an instance of InvalidIdError with the given UUID.
	 *
	 * @param {string} uuid - The UUID that is considered invalid.
	 * @returns {InvalidIdError} An instance of InvalidIdError with a descriptive error message.
	 */
	public static becauseInvalid(uuid: string): InvalidIdError {
		return new InvalidIdError(`${uuid} is not a valid v4 uuid`);
	}
	/**
	 * Creates an instance of InvalidIdError for when no UUID is provided to create an Id instance from.
	 *
	 * @returns {InvalidIdError} An instance of InvalidIdError.
	 */
	public static becauseEmpty(): InvalidIdError {
		return new InvalidIdError('Id from-method required a valid v4 uuid');
	}
}
