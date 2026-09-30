import { Command, CommandHandler, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookNotFoundException } from '../../domain/exceptions/index.js';
import { BookId } from '../../domain/models/index.js';
import { BookRepository } from '../repositories/index.js';

export class RemoveBookCommand extends Command {
	constructor(
		public readonly bookId: string,
		public readonly reason: string,
	) {
		super();
	}
}

@CommandHandler(RemoveBookCommand)
export class RemoveBookCommandHandler implements ICommandHandler<RemoveBookCommand> {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: RemoveBookCommand): Promise<void> {
		const bookId = BookId.from(command.bookId);
		const book = await this.bookRepository.getById(bookId);

		if (!book) {
			throw BookNotFoundException.withId(bookId);
		}

		// Removing a removed book again changes nothing, and saving a book without new events appends nothing.
		book.remove(command.reason);

		await this.bookRepository.save(book);
	}
}
