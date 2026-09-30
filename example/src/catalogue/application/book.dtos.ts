import type { Book } from '../domain/models/index.js';

export interface AddBookDto {
	/** Optional: an id of the client's choosing, e.g. to retry a request safely. */
	id?: string;
	title: string;
	authorIds?: string[];
	publicationDate: string;
	isbn: string;
}

export class BookDto {
	constructor(
		public readonly id: string,
		public readonly title: string,
		public readonly authorIds: string[],
		public readonly publicationDate: string,
		public readonly isbn: string,
		public readonly addedOn: string,
		/** The version of the book: the number of events in its stream. */
		public readonly version: number,
	) {}

	static from(book: Book): BookDto {
		return new BookDto(
			book.id.value,
			book.title,
			book.authorIds.map(({ value }) => value),
			book.publicationDate.toISOString(),
			book.isbn.value,
			book.addedOn.toISOString(),
			book.version,
		);
	}
}

/** An entry of the book list, the read model that BookListProjection keeps. */
export interface BookListItemDto {
	id: string;
	title: string;
}
