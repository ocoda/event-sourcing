import { Injectable } from '@nestjs/common';
import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { BookAddedEvent, BookRemovedEvent } from '../../domain/events/index.js';
import type { BookListItemDto } from '../book.dtos.js';

/**
 * The read side of the catalogue: the books that are in it, kept up to date by the subscribers below.
 *
 * It lives in memory to keep the example small, so it only knows the books added since the process started. A real
 * read model is stored, and catches up on the events it missed with `eventStore.readAll({ fromPosition })` from the
 * last global position it processed (see the event log endpoint).
 */
@Injectable()
export class BookListProjection {
	private readonly books = new Map<string, BookListItemDto>();

	list(): BookListItemDto[] {
		return [...this.books.values()];
	}

	add(book: BookListItemDto): void {
		this.books.set(book.id, book);
	}

	remove(id: string): void {
		this.books.delete(id);
	}
}

// Subscribers receive the envelopes of the events they subscribe to, after the events are stored. The bus doesn't
// await them, so the command that appended the events can complete before they ran: see eventBus.whenIdle().
@EventSubscriber(BookAddedEvent)
export class BookAddedSubscriber implements IEventSubscriber {
	constructor(private readonly projection: BookListProjection) {}

	handle({ payload }: EventEnvelope<BookAddedEvent>): void {
		this.projection.add({ id: payload.bookId, title: payload.title });
	}
}

@EventSubscriber(BookRemovedEvent)
export class BookRemovedSubscriber implements IEventSubscriber {
	constructor(private readonly projection: BookListProjection) {}

	handle({ metadata }: EventEnvelope<BookRemovedEvent>): void {
		this.projection.remove(metadata.aggregateId);
	}
}
