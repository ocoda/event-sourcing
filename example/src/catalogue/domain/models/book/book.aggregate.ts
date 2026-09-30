import { Aggregate, AggregateRoot, EventHandler } from '@ocoda/event-sourcing';
import { BookAddedEvent, BookAuthorAddedEvent, BookAuthorRemovedEvent, BookRemovedEvent } from '../../events/index.js';
import { AuthorId } from '../author/index.js';
import { BookId } from './book-id.vo.js';
import { Isbn } from './isbn.vo.js';

@Aggregate({ streamName: 'book' })
export class Book extends AggregateRoot {
	public id: BookId;
	public title: string;
	public authorIds: AuthorId[] = [];
	public publicationDate: Date;
	public isbn: Isbn;
	public addedOn: Date;
	public removedOn?: Date;

	public static add(id: BookId, title: string, authorIds: AuthorId[], publicationDate: Date, isbn: Isbn): Book {
		const book = new Book();

		book.applyEvent(
			new BookAddedEvent(
				id.value,
				title,
				authorIds.map(({ value }) => value),
				publicationDate.toISOString(),
				isbn.value,
				new Date().toISOString(),
			),
		);

		return book;
	}

	// The methods check the rules and raise events; only the event handlers below change the state.
	public addAuthor(authorId: AuthorId): void {
		if (this.hasAuthor(authorId)) {
			return;
		}
		this.applyEvent(new BookAuthorAddedEvent(authorId.value));
	}

	public removeAuthor(authorId: AuthorId): void {
		if (!this.hasAuthor(authorId)) {
			return;
		}
		this.applyEvent(new BookAuthorRemovedEvent(authorId.value));
	}

	public remove(reason: string): void {
		if (this.removedOn) {
			return;
		}
		this.applyEvent(new BookRemovedEvent(reason, new Date().toISOString()));
	}

	private hasAuthor(authorId: AuthorId): boolean {
		return this.authorIds.some((id) => id.equals(authorId));
	}

	@EventHandler(BookAddedEvent)
	onBookAddedEvent(event: BookAddedEvent) {
		this.id = BookId.from(event.bookId);
		this.title = event.title;
		this.authorIds = event.authorIds.map((id) => AuthorId.from(id));
		this.publicationDate = new Date(event.publicationDate);
		this.isbn = Isbn.from(event.isbn);
		this.addedOn = new Date(event.addedOn);
	}

	@EventHandler(BookAuthorAddedEvent)
	onBookAuthorAddedEvent(event: BookAuthorAddedEvent) {
		this.authorIds.push(AuthorId.from(event.authorId));
	}

	@EventHandler(BookAuthorRemovedEvent)
	onBookAuthorRemovedEvent(event: BookAuthorRemovedEvent) {
		this.authorIds = this.authorIds.filter(({ value }) => value !== event.authorId);
	}

	@EventHandler(BookRemovedEvent)
	onBookRemovedEvent(event: BookRemovedEvent) {
		this.removedOn = new Date(event.removedOn);
	}
}
