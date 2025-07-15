import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';

import { BookNotFoundException } from '../../domain/exceptions';
import { AuthorId, BookId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookRepository } from '../repositories';

export class RemoveBookAuthorCommand implements ICommand {
	constructor(
		public readonly bookId: string,
		public readonly authorId: string,
	) {}
}

@CommandHandler(RemoveBookAuthorCommand)
export class RemoveBookAuthorCommandHandler implements ICommandHandler {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: RemoveBookAuthorCommand): Promise<boolean> {
		const bookId = BookId.from(command.bookId);
		const book = await this.bookRepository.getById(bookId);

		if (!book) {
			throw BookNotFoundException.withId(bookId);
		}

		const authorId = AuthorId.from(command.authorId);
		book.removeAuthor(authorId);

		await this.bookRepository.save(book);

		return true;
	}
}
