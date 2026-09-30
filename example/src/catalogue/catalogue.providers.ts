import type { Provider, Type } from '@nestjs/common';
import type { IEvent } from '@ocoda/event-sourcing';
import { BookController } from './application/book.controller.js';
import {
	AddBookAuthorCommandHandler,
	AddBookCommandHandler,
	RemoveBookAuthorCommandHandler,
	RemoveBookCommandHandler,
} from './application/commands/index.js';
import { BookAddedSubscriber, BookListProjection, BookRemovedSubscriber } from './application/projections/index.js';
import { GetBookByIdQueryHandler, ListBooksQueryHandler } from './application/queries/index.js';
import { BookRepository, BookSnapshotRepository } from './application/repositories/index.js';
import {
	BookAddedEvent,
	BookAuthorAddedEvent,
	BookAuthorRemovedEvent,
	BookRemovedEvent,
} from './domain/events/index.js';

/** The events of the catalogue, registered by CatalogueModule with EventSourcingModule.forFeature(). */
export const Events: Type<IEvent>[] = [BookAddedEvent, BookAuthorAddedEvent, BookAuthorRemovedEvent, BookRemovedEvent];

// Handlers and subscribers need no registration of their own: the library discovers them among the providers.
export const Providers: Provider[] = [
	BookRepository,
	BookSnapshotRepository,
	AddBookCommandHandler,
	AddBookAuthorCommandHandler,
	RemoveBookAuthorCommandHandler,
	RemoveBookCommandHandler,
	GetBookByIdQueryHandler,
	ListBooksQueryHandler,
	BookListProjection,
	BookAddedSubscriber,
	BookRemovedSubscriber,
];

export const Controllers: Type[] = [BookController];
