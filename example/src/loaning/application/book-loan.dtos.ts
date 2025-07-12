import type { BookLoan } from '../domain/models';

export class CreateBookLoanDto {
	bookId: string;
	libraryMemberId: string;
	loanedOn: string;
	dueOn: string;
}

export class ExtendBookLoanDto {
	dueOn: string;
}

export class BookLoanDto {
	constructor(
		public readonly bookLoanId: string,
		public readonly bookId: string,
		public readonly libraryMemberId: string,
		public readonly loanedOn: string,
		public readonly dueOn: string,
	) {}

	static from(bookLoan: BookLoan): BookLoanDto {
		return new BookLoanDto(
			bookLoan.id.value,
			bookLoan.bookId.value,
			bookLoan.libraryMemberId.value,
			bookLoan.loanedOn.toISOString(),
			bookLoan.dueOn.toISOString(),
		);
	}
}
