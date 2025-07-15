import { CommandHandler, type ICommand, type ICommandHandler } from '@ocoda/event-sourcing';
import { BookNotFoundException } from '../../domain/exceptions';
import { BookId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookRepository } from '../repositories';

export class RemoveBookCommand implements ICommand {
	constructor(
		public readonly bookId: string,
		public readonly reason: string,
	) {}
}

@CommandHandler(RemoveBookCommand)
export class RemoveBookCommandHandler implements ICommandHandler {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: RemoveBookCommand): Promise<boolean> {
		const bookId = BookId.from(command.bookId);
		const book = await this.bookRepository.getById(bookId);

		if (!book) {
			throw BookNotFoundException.withId(bookId);
		}

		book.remove(command.reason);

		await this.bookRepository.save(book);

		return true;
	}
}
