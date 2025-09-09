import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';

import { AuthorId, Book, BookId, Isbn } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookRepository } from '../repositories';

export class AddBookCommand implements ICommand {
	constructor(
		public readonly title: string,
		public readonly authorIds: string[],
		public readonly publicationDate: Date,
		public readonly isbn: string,
	) {}
}

@CommandHandler(AddBookCommand)
export class AddBookCommandHandler implements ICommandHandler {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: AddBookCommand): Promise<BookId> {
		const bookId = BookId.generate();

		const book = Book.add(
			bookId,
			command.title,
			command.authorIds.map(AuthorId.from),
			command.publicationDate,
			Isbn.from(command.isbn),
		);

		await this.bookRepository.save(book);

		return bookId;
	}
}
