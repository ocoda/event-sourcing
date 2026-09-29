import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { BookRemovedEvent } from './book-removed.event.js';

@EventSubscriber(BookRemovedEvent)
export class BookRemovedEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<BookRemovedEvent>) {
		return;
	}
}
