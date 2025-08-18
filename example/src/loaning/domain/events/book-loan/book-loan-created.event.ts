import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('book-loan-created')
export class BookLoanCreatedEvent implements IEvent {
	constructor(
		public readonly bookLoanId: string,
		public readonly bookId: string,
		public readonly libraryMemberId: string,
		public readonly loanedOn: Date,
		public readonly dueOn: Date,
	) {}
}
