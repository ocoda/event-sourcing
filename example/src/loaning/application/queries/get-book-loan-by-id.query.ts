import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { BookLoanId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookLoanRepository } from '../repositories';
import { BookLoanDto } from '../book-loan.dtos';
import { BookLoanNotFoundException } from '../../domain/exceptions';

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
