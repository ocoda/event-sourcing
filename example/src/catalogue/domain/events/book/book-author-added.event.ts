import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('book-author-added')
export class BookAuthorAddedEvent implements IEvent {
	constructor(public readonly authorId: string) {}
}
