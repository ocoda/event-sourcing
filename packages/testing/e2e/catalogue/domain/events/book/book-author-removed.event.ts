import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('book-author-removed')
export class BookAuthorRemovedEvent implements IEvent {
	constructor(public readonly authorId: string) {}
}
