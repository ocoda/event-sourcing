import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { BookAddedEvent } from './book-added.event';
import { BookRemovedEvent } from './book-removed.event';

@EventSubscriber(BookAddedEvent, BookRemovedEvent)
export class BookEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<BookAddedEvent | BookRemovedEvent>): void {
		switch (metadata.constructor) {
			case BookAddedEvent:
				// Handle BookAddedEvent
				break;
			case BookRemovedEvent:
				// Handle BookRemovedEvent
				break;
		}
	}
}
