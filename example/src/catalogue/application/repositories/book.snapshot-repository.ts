import { type ISnapshot, Snapshot, SnapshotRepository } from '@ocoda/event-sourcing';
import { AuthorId } from '../../domain/models/author';
import { BookId } from '../../domain/models/book/book-id.vo';
import { Book } from '../../domain/models/book/book.aggregate';

@Snapshot(Book, { name: 'book', interval: 5 })
export class BookSnapshotRepository extends SnapshotRepository<Book> {
	serialize({ id, title, authorIds, publicationDate, isbn, addedOn, removedOn }: Book): ISnapshot<Book> {
		return {
			id: id.value,
			title,
			authorIds: authorIds.map(({ value }) => value),
			publicationDate: publicationDate?.toISOString(),
			isbn,
			addedOn: addedOn?.toISOString(),
			removedOn: removedOn?.toISOString(),
		};
	}
	deserialize({ id, title, authorIds, publicationDate, isbn, addedOn, removedOn }: ISnapshot<Book>): Book {
		const book = new Book();
		book.id = BookId.from(id);
		book.title = title;
		book.authorIds = authorIds.map(AuthorId.from);
		book.publicationDate = new Date(publicationDate);
		book.isbn = isbn;
		book.addedOn = new Date(addedOn);
		book.removedOn = removedOn && new Date(removedOn);

		return book;
	}
}
