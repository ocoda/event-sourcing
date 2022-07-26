import { DomainError } from './domain-error';

export class InvalidIdError extends DomainError {
  public static withString(value: string): InvalidIdError {
    return new InvalidIdError(`${value} is not a valid v4 uuid.`);
  }
}
