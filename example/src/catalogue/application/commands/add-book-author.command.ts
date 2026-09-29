import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookNotFoundException } from '../../domain/exceptions/index.js';
import { AuthorId, BookId } from '../../domain/models/index.js';
import { BookRepository } from '../repositories/index.js';

export class AddBookAuthorCommand implements ICommand {
	constructor(
		public readonly bookId: string,
		public readonly authorId: string,
	) {}
}

@CommandHandler(AddBookAuthorCommand)
export class AddBookAuthorCommandHandler implements ICommandHandler {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: AddBookAuthorCommand): Promise<boolean> {
		const bookId = BookId.from(command.bookId);
		const book = await this.bookRepository.getById(bookId);

		if (!book) {
			throw BookNotFoundException.withId(bookId);
		}

		const authorId = AuthorId.from(command.authorId);
		book.addAuthor(authorId);

		await this.bookRepository.save(book);

		return true;
	}
}
