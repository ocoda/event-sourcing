import { DomainException, type Id } from '@ocoda/event-sourcing';

export class InsufficientFundsException extends DomainException {
	static because(cause: string, id?: Id): DomainException {
		return new InsufficientFundsException(cause, id);
	}
}
