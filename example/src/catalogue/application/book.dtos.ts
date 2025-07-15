import type { Book } from '../domain/models';

export class AddBookDto {
	title: string;
	authorIds: string[];
	publicationDate: string;
	isbn: string;
}

export class AddBookAuthorDto {
	authorId: string;
}

export class RemoveBookAuthorDto {
	authorId: string;
}

export class RemoveBookDto {
	reason: string;
}

export class BookDto {
	constructor(
		public readonly id: string,
		public readonly title: string,
		public readonly authorIds: string[],
		public readonly publicationDate: string,
		public readonly isbn: string,
	) {}

	static from(book: Book): BookDto {
		return new BookDto(
			book.id.value,
			book.title,
			book.authorIds.map(({ value }) => value),
			book.publicationDate.toISOString(),
			book.isbn.value,
		);
	}
}
