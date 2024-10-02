import { DomainError, type Id } from '@ocoda/event-sourcing';

export class InsufficientFundsException extends DomainError {
	static because(cause: string, id?: Id): DomainError {
		return new InsufficientFundsException(cause, id);
	}
}
