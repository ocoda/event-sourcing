import { Aggregate, AggregateRoot, EventHandler } from '@ocoda/event-sourcing';
import { BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent } from '../../events/index.js';
import { BookLoanAlreadyReturnedException } from '../../exceptions/book-loan-already-returned.exception.js';
import { LibraryMemberId } from '../library-member-id.vo.js';
import { BookId } from './book-id.vo.js';
import { BookLoanId } from './book-loan-id.vo.js';

@Aggregate({ streamName: 'book-loan' })
export class BookLoan extends AggregateRoot {
	public id: BookLoanId;
	public bookId: BookId;
	public libraryMemberId: LibraryMemberId;
	public loanedOn: Date;
	public dueOn: Date;
	public returnedOn?: Date;

	public static create(
		id: BookLoanId,
		bookId: BookId,
		libraryMemberId: LibraryMemberId,
		loanedOn: Date,
		dueOn: Date,
	): BookLoan {
		const bookLoan = new BookLoan();

		bookLoan.applyEvent(
			new BookLoanCreatedEvent(
				id.value,
				bookId.value,
				libraryMemberId.value,
				loanedOn.toISOString(),
				dueOn.toISOString(),
			),
		);

		return bookLoan;
	}

	public extend(dueOn: Date): void {
		if (this.returnedOn) {
			throw BookLoanAlreadyReturnedException.withId(this.id);
		}
		this.applyEvent(new BookLoanExtendedEvent(dueOn.toISOString()));
	}

	public return(): void {
		if (this.returnedOn) {
			return;
		}
		this.applyEvent(new BookLoanReturnedEvent(new Date().toISOString()));
	}

	@EventHandler(BookLoanCreatedEvent)
	onBookLoanCreatedEvent(event: BookLoanCreatedEvent) {
		this.id = BookLoanId.from(event.bookLoanId);
		this.bookId = BookId.from(event.bookId);
		this.libraryMemberId = LibraryMemberId.from(event.libraryMemberId);
		this.loanedOn = new Date(event.loanedOn);
		this.dueOn = new Date(event.dueOn);
	}

	@EventHandler(BookLoanExtendedEvent)
	onBookLoanExtendedEvent(event: BookLoanExtendedEvent) {
		this.dueOn = new Date(event.dueOn);
	}

	@EventHandler(BookLoanReturnedEvent)
	onBookLoanReturnedEvent(event: BookLoanReturnedEvent) {
		this.returnedOn = new Date(event.returnedOn);
	}
}
