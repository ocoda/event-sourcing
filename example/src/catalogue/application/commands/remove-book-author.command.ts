import { Command, CommandHandler, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookNotFoundException } from '../../domain/exceptions/index.js';
import { AuthorId, BookId } from '../../domain/models/index.js';
import { BookRepository } from '../repositories/index.js';

export class RemoveBookAuthorCommand extends Command {
	constructor(
		public readonly bookId: string,
		public readonly authorId: string,
	) {
		super();
	}
}

@CommandHandler(RemoveBookAuthorCommand)
export class RemoveBookAuthorCommandHandler implements ICommandHandler<RemoveBookAuthorCommand> {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: RemoveBookAuthorCommand): Promise<void> {
		const bookId = BookId.from(command.bookId);
		const book = await this.bookRepository.getById(bookId);

		if (!book || book.removedOn) {
			throw BookNotFoundException.withId(bookId);
		}

		book.removeAuthor(AuthorId.from(command.authorId));

		await this.bookRepository.save(book);
	}
}
