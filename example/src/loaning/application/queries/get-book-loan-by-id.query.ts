import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { BookLoanNotFoundException } from '../../domain/exceptions';
import { BookLoanId } from '../../domain/models';
import { BookLoanDto } from '../book-loan.dtos';
// biome-ignore lint/style/useImportType: DI
import { BookLoanRepository } from '../repositories';

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
