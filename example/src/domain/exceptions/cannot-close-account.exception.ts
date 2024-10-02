import { DomainError, type Id } from '@ocoda/event-sourcing';

export class CannotCloseAccountException extends DomainError {
	static because(cause: string, id?: Id): DomainError {
		return new CannotCloseAccountException(cause, id);
	}
}
