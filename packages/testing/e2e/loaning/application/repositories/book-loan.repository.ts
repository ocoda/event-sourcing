import { Injectable } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { EventStore, EventStream } from '@ocoda/event-sourcing';
import { BookLoan, BookLoanId } from '../../domain/models';
// biome-ignore lint/style/useImportType: DI
import { BookLoanSnapshotRepository } from './book-loan.snapshot-repository';

@Injectable()
export class BookLoanRepository {
	constructor(
		private readonly eventStore: EventStore,
		private readonly bookLoanSnapshotRepository: BookLoanSnapshotRepository,
	) {}

	async getById(bookLoanId: BookLoanId): Promise<BookLoan | void> {
		const eventStream = EventStream.for<BookLoan>(BookLoan, bookLoanId);

		const bookLoan = await this.bookLoanSnapshotRepository.load(bookLoanId);

		const eventCursor = this.eventStore.getEvents(eventStream, {
			fromVersion: bookLoan.version + 1,
		});

		await bookLoan.loadFromHistory(eventCursor);

		if (bookLoan.version < 1) {
			return;
		}

		return bookLoan;
	}

	async getByIds(bookLoanIds: BookLoanId[]) {
		const bookLoans = await this.bookLoanSnapshotRepository.loadMany(bookLoanIds, 'e2e');

		for (const bookLoan of bookLoans) {
			const eventStream = EventStream.for<BookLoan>(BookLoan, bookLoan.id);
			const eventCursor = this.eventStore.getEvents(eventStream, { pool: 'e2e', fromVersion: bookLoan.version + 1 });
			await bookLoan.loadFromHistory(eventCursor);
		}

		return bookLoans;
	}

	async getAll(bookLoanId?: BookLoanId, limit?: number): Promise<BookLoan[]> {
		const bookLoans: BookLoan[] = [];
		for await (const envelopes of this.bookLoanSnapshotRepository.loadAll({
			aggregateId: bookLoanId,
			limit,
		})) {
			for (const { metadata, payload } of envelopes) {
				const id = BookLoanId.from(metadata.aggregateId);
				const eventStream = EventStream.for<BookLoan>(BookLoan, id);
				const bookLoan = this.bookLoanSnapshotRepository.deserialize(payload);

				const eventCursor = this.eventStore.getEvents(eventStream, { fromVersion: metadata.version + 1 });
				await bookLoan.loadFromHistory(eventCursor);

				bookLoans.push(bookLoan);
			}
		}

		return bookLoans;
	}

	async save(bookLoan: BookLoan): Promise<void> {
		const events = bookLoan.commit();
		const stream = EventStream.for<BookLoan>(BookLoan, bookLoan.id);

		await this.eventStore.appendEvents(stream, bookLoan.version, events);
		await this.bookLoanSnapshotRepository.save(bookLoan.id, bookLoan);
	}
}
