export class DomainError extends Error {
	public static because(cause: string): DomainError {
		return new DomainError(cause);
	}
}
