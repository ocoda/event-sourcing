import { DomainError } from './domain-error';

export class InvalidIdError extends DomainError {
	public static becauseInvalid(uuid: string): InvalidIdError {
		return new InvalidIdError(`${uuid} is not a valid v4 uuid`);
	}
	public static becauseEmpty(): InvalidIdError {
		return new InvalidIdError('Id from-method required a valid v4 uuid');
	}
}
