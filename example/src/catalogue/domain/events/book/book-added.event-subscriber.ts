import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { BookAddedEvent } from './book-added.event.js';

@EventSubscriber(BookAddedEvent)
export class BookAddedEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<BookAddedEvent>) {
		return;
	}
}
