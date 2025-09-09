import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('book-added')
export class BookAddedEvent implements IEvent {
	constructor(
		public readonly bookId: string,
		public readonly title: string,
		public readonly authorIds: string[],
		public readonly publicationDate: Date,
		public readonly isbn: string,
		public readonly addedOn: Date,
	) {}
}
