import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('book-title-changed')
export class BookTitleChangedEvent implements IEvent {
	constructor(
		public readonly bookId: string,
		public readonly title: string,
	) {}
}
