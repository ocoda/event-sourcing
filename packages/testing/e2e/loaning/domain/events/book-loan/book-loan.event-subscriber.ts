import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { BookLoanCreatedEvent } from './book-loan-created.event';
import { BookLoanExtendedEvent } from './book-loan-extended.event';
import { BookLoanReturnedEvent } from './book-loan-returned.event';

@EventSubscriber(BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent)
export class BookLoanEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<BookLoanCreatedEvent | BookLoanExtendedEvent | BookLoanReturnedEvent>): void {
		switch (metadata.constructor) {
			case BookLoanCreatedEvent:
				// Handle BookLoanCreatedEvent
				break;
			case BookLoanExtendedEvent:
				// Handle BookLoanExtendedEvent
				break;
			case BookLoanReturnedEvent:
				// Handle BookLoanReturnedEvent
				break;
		}
	}
}
