import { DomainException, type Id } from '@ocoda/event-sourcing';

export class CannotCloseAccountException extends DomainException {
	static because(cause: string, id?: Id): DomainException {
		return new CannotCloseAccountException(cause, id);
	}
}
