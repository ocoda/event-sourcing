import { DomainException } from './domain-error';

export class InvalidIdException extends DomainException {
	/**
	 * Creates an instance of InvalidIdException with the given UUID.
	 *
	 * @param {string} uuid - The UUID that is considered invalid.
	 * @returns {InvalidIdException} An instance of InvalidIdException with a descriptive error message.
	 */
	public static becauseInvalid(uuid: string): InvalidIdException {
		return new InvalidIdException(`${uuid} is not a valid v4 uuid`);
	}
	/**
	 * Creates an instance of InvalidIdException for when no UUID is provided to create an Id instance from.
	 *
	 * @returns {InvalidIdException} An instance of InvalidIdException.
	 */
	public static becauseEmpty(): InvalidIdException {
		return new InvalidIdException('Id from-method required a valid v4 uuid');
	}
	/**
	 * Creates a generic instance of InvalidIdException.
	 *
	 * @returns {InvalidIdException} An instance of InvalidIdException.
	 */
	public static because(cause: string): DomainException {
		return new InvalidIdException(cause);
	}
}
