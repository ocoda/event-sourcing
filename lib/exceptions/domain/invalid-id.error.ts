import { DomainError } from './domain-error';

export class InvalidIdError extends DomainError {
  public static becauseInvalid(uuid: string): InvalidIdError {
    return new InvalidIdError(`${uuid} is not a valid v4 uuid`);
  }
}
