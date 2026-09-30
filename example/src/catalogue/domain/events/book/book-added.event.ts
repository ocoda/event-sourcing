import { Event, type IEvent } from '@ocoda/event-sourcing';

// Events hold plain values. The default JSON serializer stores a Date as an ISO string in PostgreSQL and reads it back
// as that string, so the dates are ISO strings from the start and the aggregate turns them into dates.
@Event('book-added')
export class BookAddedEvent implements IEvent {
	constructor(
		public readonly bookId: string,
		public readonly title: string,
		public readonly authorIds: string[],
		public readonly publicationDate: string,
		public readonly isbn: string,
		public readonly addedOn: string,
	) {}
}
