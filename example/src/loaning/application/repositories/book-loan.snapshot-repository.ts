import { type ISnapshot, Snapshot, SnapshotRepository } from '@ocoda/event-sourcing';
import { BookId, BookLoan, BookLoanId, LibraryMemberId } from '../../domain/models';

@Snapshot(BookLoan, { name: 'book-loan', interval: 5 })
export class BookLoanSnapshotRepository extends SnapshotRepository<BookLoan> {
	serialize({ id, bookId, libraryMemberId, loanedOn, dueOn, returnedOn }: BookLoan): ISnapshot<BookLoan> {
		return {
			id: id.value,
			bookId: bookId.value,
			libraryMemberId: libraryMemberId.value,
			loanedOn: loanedOn.toISOString(),
			dueOn: dueOn.toISOString(),
			returnedOn: returnedOn?.toISOString(),
		};
	}
	deserialize({ id, bookId, libraryMemberId, loanedOn, dueOn, returnedOn }: ISnapshot<BookLoan>): BookLoan {
		const bookLoan = new BookLoan();
		bookLoan.id = BookLoanId.from(id);
		bookLoan.bookId = BookId.from(bookId);
		bookLoan.libraryMemberId = LibraryMemberId.from(libraryMemberId);
		bookLoan.loanedOn = new Date(loanedOn);
		bookLoan.dueOn = new Date(dueOn);
		bookLoan.returnedOn = returnedOn && new Date(returnedOn);

		return bookLoan;
	}
}
