import { Command, CommandHandler, type ICommandHandler } from '@ocoda/event-sourcing';
import { AuthorId, Book, BookId, Isbn } from '../../domain/models/index.js';
import { BookRepository } from '../repositories/index.js';

/** Adds a book to the catalogue and resolves to its id. */
export class AddBookCommand extends Command<string> {
	constructor(
		public readonly title: string,
		public readonly authorIds: string[],
		public readonly publicationDate: Date,
		public readonly isbn: string,
		/** An id chosen by the client, so it can retry the command safely; generated when absent. */
		public readonly bookId?: string,
	) {
		super();
	}
}

@CommandHandler(AddBookCommand)
export class AddBookCommandHandler implements ICommandHandler<AddBookCommand> {
	constructor(private readonly bookRepository: BookRepository) {}

	async execute(command: AddBookCommand): Promise<string> {
		const bookId = command.bookId ? BookId.from(command.bookId) : BookId.generate();

		const book = Book.add(
			bookId,
			command.title,
			command.authorIds.map((id) => AuthorId.from(id)),
			command.publicationDate,
			Isbn.from(command.isbn),
		);

		// A new aggregate has committedVersion 0, so the append expects an empty stream: when a book with this id already
		// exists, it rejects with an EventStoreVersionConflictException instead of mixing two books into one stream.
		await this.bookRepository.save(book);

		return bookId.value;
	}
}
