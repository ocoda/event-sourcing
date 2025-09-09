import { Injectable } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { EventStore, EventStream } from '@ocoda/event-sourcing';
import { Book, BookId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookSnapshotRepository } from './book.snapshot-repository';

@Injectable()
export class BookRepository {
	constructor(
		private readonly eventStore: EventStore,
		private readonly bookSnapshotRepository: BookSnapshotRepository,
	) {}

	async getById(bookId: BookId): Promise<Book | void> {
		const eventStream = EventStream.for<Book>(Book, bookId);

		const book = await this.bookSnapshotRepository.load(bookId);

		const eventCursor = this.eventStore.getEvents(eventStream, {
			fromVersion: book.version + 1,
		});

		await book.loadFromHistory(eventCursor);

		if (book.version < 1) {
			return;
		}

		return book;
	}

	async getByIds(bookIds: BookId[]) {
		const books = await this.bookSnapshotRepository.loadMany(bookIds, 'e2e');

		for (const book of books) {
			const eventStream = EventStream.for<Book>(Book, book.id);
			const eventCursor = this.eventStore.getEvents(eventStream, { pool: 'e2e', fromVersion: book.version + 1 });
			await book.loadFromHistory(eventCursor);
		}

		return books;
	}

	async getAll(bookId?: BookId, limit?: number): Promise<Book[]> {
		const books: Book[] = [];
		for await (const envelopes of this.bookSnapshotRepository.loadAll({
			aggregateId: bookId,
			limit,
		})) {
			for (const { metadata, payload } of envelopes) {
				const id = BookId.from(metadata.aggregateId);
				const eventStream = EventStream.for<Book>(Book, id);
				const book = this.bookSnapshotRepository.deserialize(payload);

				const eventCursor = this.eventStore.getEvents(eventStream, { fromVersion: metadata.version + 1 });
				await book.loadFromHistory(eventCursor);

				books.push(book);
			}
		}

		return books;
	}

	async save(book: Book): Promise<void> {
		const events = book.commit();
		const stream = EventStream.for<Book>(Book, book.id);

		await this.eventStore.appendEvents(stream, book.version, events);
		await this.bookSnapshotRepository.save(book.id, book);
	}
}
