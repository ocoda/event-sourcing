import { Command, CommandHandler, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookNotFoundException } from '../../domain/exceptions/index.js';
import { AuthorId, BookId } from '../../domain/models/index.js';
import { BookRepository } from '../repositories/index.js';

export class AddBookAuthorCommand extends Command {
	constructor(
		public readonly bookId: string,
		public readonly authorId: string,
	) {
		super();
	}
}

@CommandHandler(AddBookAuthorCommand)
export class AddBookAuthorCommandHandler implements ICommandHandler<AddBookAuthorCommand> {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: AddBookAuthorCommand): Promise<void> {
		const bookId = BookId.from(command.bookId);
		const book = await this.bookRepository.getById(bookId);

		if (!book || book.removedOn) {
			throw BookNotFoundException.withId(bookId);
		}

		book.addAuthor(AuthorId.from(command.authorId));

		await this.bookRepository.save(book);
	}
}
