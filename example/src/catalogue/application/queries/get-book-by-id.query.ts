import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { BookNotFoundException } from '../../domain/exceptions';
import { BookId } from '../../domain/models';
import { BookDto } from '../book.dtos';
// biome-ignore lint/style/useImportType: DI
import { BookRepository } from '../repositories';

export class GetBookByIdQuery implements IQuery {
	constructor(public readonly bookId: string) {}
}

@QueryHandler(GetBookByIdQuery)
export class GetBookByIdQueryHandler implements IQueryHandler<GetBookByIdQuery, BookDto> {
	constructor(private readonly bookRepository: BookRepository) {}

	public async execute(query: GetBookByIdQuery): Promise<BookDto> {
		const bookId = BookId.from(query.bookId);

		const book = await this.bookRepository.getById(bookId);

		if (!book || book.removedOn) {
			throw BookNotFoundException.withId(bookId);
		}

		return BookDto.from(book);
	}
}
