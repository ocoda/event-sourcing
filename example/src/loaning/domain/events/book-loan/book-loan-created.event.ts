import { Event, type IEvent } from '@ocoda/event-sourcing';

// Dates are ISO strings: the default JSON serializer reads a stored Date back as a string.
@Event('book-loan-created')
export class BookLoanCreatedEvent implements IEvent {
	constructor(
		public readonly bookLoanId: string,
		public readonly bookId: string,
		public readonly libraryMemberId: string,
		public readonly loanedOn: string,
		public readonly dueOn: string,
	) {}
}
