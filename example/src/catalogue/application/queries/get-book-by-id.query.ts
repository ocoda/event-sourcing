import { Query, QueryHandler, type IQueryHandler } from '@ocoda/event-sourcing';
import { BookNotFoundException } from '../../domain/exceptions/index.js';
import { BookId } from '../../domain/models/index.js';
import { BookDto } from '../book.dtos.js';
import { BookRepository } from '../repositories/index.js';

export class GetBookByIdQuery extends Query<BookDto> {
	constructor(public readonly bookId: string) {
		super();
	}
}

@QueryHandler(GetBookByIdQuery)
export class GetBookByIdQueryHandler implements IQueryHandler<GetBookByIdQuery> {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(query: GetBookByIdQuery): Promise<BookDto> {
		const bookId = BookId.from(query.bookId);
		const book = await this.bookRepository.getById(bookId);

		if (!book || book.removedOn) {
			throw BookNotFoundException.withId(bookId);
		}

		return BookDto.from(book);
	}
}
