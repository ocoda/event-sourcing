import { Aggregate, AggregateRoot, EventHandler } from '@ocoda/event-sourcing';
import { BookAddedEvent, BookAuthorAddedEvent, BookAuthorRemovedEvent, BookRemovedEvent } from '../../events';
import { AuthorId } from '../author';
import { BookId } from './book-id.vo';
import { Isbn } from './isbn.vo';

@Aggregate({ streamName: 'book' })
export class Book extends AggregateRoot {
	public id: BookId;
	public title: string;
	public authorIds: AuthorId[];
	public publicationDate: Date;
	public isbn: Isbn;
	public addedOn: Date;
	public removedOn?: Date;

	public static add(bookId: BookId, title: string, authorIds: AuthorId[], publicationDate: Date, isbn: Isbn): Book {
		const book = new Book();

		book.applyEvent(
			new BookAddedEvent(
				bookId.value,
				title,
				authorIds.map(({ value }) => value),
				publicationDate,
				isbn.value,
				new Date(),
			),
		);

		return book;
	}

	public addAuthor(authorId: AuthorId) {
		this.applyEvent(new BookAuthorAddedEvent(authorId.value));
	}

	public removeAuthor(authorId: AuthorId) {
		this.applyEvent(new BookAuthorRemovedEvent(authorId.value));
	}

	public remove(reason: string) {
		this.applyEvent(new BookRemovedEvent(reason));
	}

	@EventHandler(BookAddedEvent)
	onBookAddedEvent(event: BookAddedEvent) {
		this.id = BookId.from(event.bookId);
		this.title = event.title;
		this.authorIds = event.authorIds.map(AuthorId.from);
		this.publicationDate = event.publicationDate;
		this.isbn = Isbn.from(event.isbn);
		this.addedOn = event.addedOn;
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
	onBookRemovedEvent() {
		this.removedOn = new Date();
	}
}
