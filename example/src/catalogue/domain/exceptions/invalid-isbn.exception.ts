import { DomainException } from '@ocoda/event-sourcing';

export class InvalidIsbnException extends DomainException {
	/**
	 * Creates an instance of InvalidIsbnException with the given value.
	 *
	 * @param {string} isbn - The Isbn that is considered invalid.
	 * @returns {InvalidIdException} An instance of InvalidIdException with a descriptive error message.
	 */
	public static becauseInvalid(isbn: string): InvalidIsbnException {
		return new InvalidIsbnException(`${isbn} is not a valid isbn`);
	}
	/**
	 * Creates an instance of InvalidIsbnException for when no value is provided to create an Isbn instance from.
	 *
	 * @returns {InvalidIsbnException} An instance of InvalidIsbnException.
	 */
	public static becauseEmpty(): InvalidIsbnException {
		return new InvalidIsbnException('Isbn from-method requires a valid isbn');
	}
	/**
	 * Creates a generic instance of InvalidIsbnException.
	 *
	 * @returns {InvalidIsbnException} An instance of InvalidIsbnException.
	 */
	public static because(cause: string): DomainException {
		return new InvalidIsbnException(cause);
	}
}
