import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { BookLoanNotFoundException } from '../../domain/exceptions/index.js';
import { BookLoanId } from '../../domain/models/index.js';
import { BookLoanDto } from '../book-loan.dtos.js';
import { BookLoanRepository } from '../repositories/index.js';

export class GetBookLoanByIdQuery implements IQuery {
	constructor(public readonly bookLoanId: string) {}
}

@QueryHandler(GetBookLoanByIdQuery)
export class GetBookLoanByIdQueryHandler implements IQueryHandler<GetBookLoanByIdQuery, BookLoanDto> {
	constructor(private readonly bookLoanRepository: BookLoanRepository) {}

	public async execute(query: GetBookLoanByIdQuery): Promise<BookLoanDto> {
		const bookLoanId = BookLoanId.from(query.bookLoanId);

		const bookLoan = await this.bookLoanRepository.getById(bookLoanId);

		if (!bookLoan) {
			throw BookLoanNotFoundException.withId(bookLoanId);
		}

		return BookLoanDto.from(bookLoan);
	}
}
