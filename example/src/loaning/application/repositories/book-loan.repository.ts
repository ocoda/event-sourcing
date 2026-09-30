import { Injectable } from '@nestjs/common';
import { EventStore, EventStream } from '@ocoda/event-sourcing';
import { BookLoan, type BookLoanId } from '../../domain/models/index.js';
import { BookLoanSnapshotRepository } from './book-loan.snapshot-repository.js';

@Injectable()
export class BookLoanRepository {
	constructor(
		private readonly eventStore: EventStore,
		private readonly bookLoanSnapshotRepository: BookLoanSnapshotRepository,
	) {}

	async getById(bookLoanId: BookLoanId): Promise<BookLoan | undefined> {
		const bookLoan = await this.bookLoanSnapshotRepository.load(bookLoanId);

		const events = this.eventStore.getEvents(EventStream.for<BookLoan>(BookLoan, bookLoanId), {
			fromVersion: bookLoan.version + 1,
		});
		await bookLoan.loadFromHistory(events);

		return bookLoan.version > 0 ? bookLoan : undefined;
	}

	async save(bookLoan: BookLoan): Promise<void> {
		const events = bookLoan.getUncommittedEvents();
		const stream = EventStream.for<BookLoan>(BookLoan, bookLoan.id);

		await this.eventStore.appendEvents(stream, events, { expectedVersion: bookLoan.committedVersion });
		bookLoan.markCommitted(events);

		await this.bookLoanSnapshotRepository.save(bookLoan.id, bookLoan);
	}
}
