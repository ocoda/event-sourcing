export class DomainError extends Error {
	/**
	 * Creates a new instance of DomainError with the given cause.
	 *
	 * @param {string} cause - The cause of the domain error.
	 * @returns {DomainError} An instance of DomainError.
	 */
	public static because(cause: string): DomainError {
		return new DomainError(cause);
	}
}
