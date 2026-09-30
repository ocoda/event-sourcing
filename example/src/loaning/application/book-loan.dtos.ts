import type { BookLoan } from '../domain/models/index.js';

export interface CreateBookLoanDto {
	bookId: string;
	libraryMemberId: string;
	/** Defaults to now. */
	loanedOn?: string;
	dueOn: string;
}

export class BookLoanDto {
	constructor(
		public readonly id: string,
		public readonly bookId: string,
		public readonly libraryMemberId: string,
		public readonly loanedOn: string,
		public readonly dueOn: string,
		public readonly returnedOn: string | undefined,
		public readonly version: number,
	) {}

	static from(bookLoan: BookLoan): BookLoanDto {
		return new BookLoanDto(
			bookLoan.id.value,
			bookLoan.bookId.value,
			bookLoan.libraryMemberId.value,
			bookLoan.loanedOn.toISOString(),
			bookLoan.dueOn.toISOString(),
			bookLoan.returnedOn?.toISOString(),
			bookLoan.version,
		);
	}
}
