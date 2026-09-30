import { type ISnapshot, Snapshot, SnapshotRepository } from '@ocoda/event-sourcing';
import { AuthorId, Book, BookId, Isbn } from '../../domain/models/index.js';

@Snapshot(Book, { name: 'book', interval: 5 })
export class BookSnapshotRepository extends SnapshotRepository<Book> {
	serialize({ id, title, authorIds, publicationDate, isbn, addedOn, removedOn }: Book): ISnapshot<Book> {
		return {
			id: id.value,
			title,
			authorIds: authorIds.map(({ value }) => value),
			publicationDate: publicationDate.toISOString(),
			isbn: isbn.value,
			addedOn: addedOn.toISOString(),
			removedOn: removedOn?.toISOString(),
		};
	}

	deserialize({ id, title, authorIds, publicationDate, isbn, addedOn, removedOn }: ISnapshot<Book>): Book {
		const book = new Book();
		book.id = BookId.from(id);
		book.title = title;
		book.authorIds = authorIds.map((authorId: string) => AuthorId.from(authorId));
		book.publicationDate = new Date(publicationDate);
		book.isbn = Isbn.from(isbn);
		book.addedOn = new Date(addedOn);
		book.removedOn = removedOn ? new Date(removedOn) : undefined;

		return book;
	}
}
