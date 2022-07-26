export class DomainError extends Error {
  protected constructor(stack?: string) {
    super(stack);
  }

  public static because(cause: string): DomainError {
    return new DomainError(cause);
  }
}
