import { Injectable } from '@nestjs/common';
import { EventStore, EventStream } from '@ocoda/event-sourcing';
import { Book, type BookId } from '../../domain/models/index.js';
import { BookSnapshotRepository } from './book.snapshot-repository.js';

@Injectable()
export class BookRepository {
	constructor(
		private readonly eventStore: EventStore,
		private readonly bookSnapshotRepository: BookSnapshotRepository,
	) {}

	/** Loads the book from its latest snapshot and the events after it, or returns `undefined` for an unknown id. */
	async getById(bookId: BookId): Promise<Book | undefined> {
		const book = await this.bookSnapshotRepository.load(bookId);

		const events = this.eventStore.getEvents(EventStream.for<Book>(Book, bookId), {
			fromVersion: book.version + 1,
		});
		await book.loadFromHistory(events);

		return book.version > 0 ? book : undefined;
	}

	/**
	 * Appends the events the book raised since it was loaded. `committedVersion` is the version the stream had then: when
	 * another writer appended in the meantime, the append rejects with an `EventStoreVersionConflictException` and stores
	 * nothing.
	 */
	async save(book: Book): Promise<void> {
		const events = book.getUncommittedEvents();
		const stream = EventStream.for<Book>(Book, book.id);

		await this.eventStore.appendEvents(stream, events, { expectedVersion: book.committedVersion });
		book.markCommitted();

		// Takes a snapshot when one is due (every 5 versions, see BookSnapshotRepository). Never rejects.
		await this.bookSnapshotRepository.save(book.id, book);
	}
}
