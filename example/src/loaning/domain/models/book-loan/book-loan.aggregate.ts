import { Aggregate, AggregateRoot, EventHandler } from '@ocoda/event-sourcing';
import { BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent } from '../../events';
import {} from '../../exceptions';
import { LibraryMemberId } from '../library-member-id.vo';
import { BookLoanId } from './book-loan-id.vo';
import { BookId } from './book-id.vo';

@Aggregate({ streamName: 'book-loan' })
export class BookLoan extends AggregateRoot {
	public id: BookLoanId;
	public bookId: BookId;
	public libraryMemberId: LibraryMemberId;
	public loanedOn: Date;
	public dueOn: Date;
	public returnedOn?: Date;

	public static create(
		bookLoanId: BookLoanId,
		bookId: BookId,
		libraryMemberId: LibraryMemberId,
		loanedOn: Date,
		dueOn: Date,
	): BookLoan {
		const bookLoan = new BookLoan();

		bookLoan.applyEvent(
			new BookLoanCreatedEvent(bookLoanId.value, bookId.value, libraryMemberId.value, loanedOn, dueOn),
		);

		return bookLoan;
	}

	public extend(dueOn: Date) {
		this.applyEvent(new BookLoanExtendedEvent(dueOn));
	}

	public return() {
		this.applyEvent(new BookLoanReturnedEvent());
	}

	@EventHandler(BookLoanCreatedEvent)
	onBookLoanCreatedEvent(event: BookLoanCreatedEvent) {
		this.id = BookLoanId.from(event.bookLoanId);
		this.bookId = BookId.from(event.bookId);
		this.libraryMemberId = LibraryMemberId.from(event.libraryMemberId);
		this.loanedOn = event.loanedOn;
		this.dueOn = event.dueOn;
	}

	@EventHandler(BookLoanExtendedEvent)
	onBookLoanExtendedEvent(event: BookLoanExtendedEvent) {
		this.dueOn = event.dueOn;
	}

	@EventHandler(BookLoanReturnedEvent)
	onBookLoanReturnedEvent() {
		this.returnedOn = new Date();
	}
}
