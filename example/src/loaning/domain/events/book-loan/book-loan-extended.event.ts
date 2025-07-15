import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('book-loan-extended')
export class BookLoanExtendedEvent implements IEvent {
	constructor(public readonly dueOn: Date) {}
}
