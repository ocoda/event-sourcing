import { Query, QueryHandler, type IQueryHandler } from '@ocoda/event-sourcing';
import { BookLoanNotFoundException } from '../../domain/exceptions/index.js';
import { BookLoanId } from '../../domain/models/index.js';
import { BookLoanDto } from '../book-loan.dtos.js';
import { BookLoanRepository } from '../repositories/index.js';

export class GetBookLoanByIdQuery extends Query<BookLoanDto> {
	constructor(public readonly bookLoanId: string) {
		super();
	}
}

@QueryHandler(GetBookLoanByIdQuery)
export class GetBookLoanByIdQueryHandler implements IQueryHandler<GetBookLoanByIdQuery> {
	constructor(private readonly bookLoanRepository: BookLoanRepository) {}

	async execute(query: GetBookLoanByIdQuery): Promise<BookLoanDto> {
		const bookLoanId = BookLoanId.from(query.bookLoanId);
		const bookLoan = await this.bookLoanRepository.getById(bookLoanId);

		if (!bookLoan) {
			throw BookLoanNotFoundException.withId(bookLoanId);
		}

		return BookLoanDto.from(bookLoan);
	}
}
