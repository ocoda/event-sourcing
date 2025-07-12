import type { Type } from '@nestjs/common';
import type { Controller } from '@nestjs/common/interfaces';
import type {
	ICommandHandler,
	IEvent,
	IEventSubscriber,
	IQueryHandler,
	SnapshotRepository,
} from '@ocoda/event-sourcing';
import { BookController } from './application/book.controller';
import {
	AddBookAuthorCommandHandler,
	AddBookCommandHandler,
	RemoveBookAuthorCommandHandler,
	RemoveBookCommandHandler,
} from './application/commands';
import { CustomEventPublisher } from './application/publishers';
import { GetBookByIdQueryHandler } from './application/queries';
import { BookRepository, BookSnapshotRepository } from './application/repositories';
import {
	BookAddedEvent,
	BookAddedEventSubscriber,
	BookAuthorAddedEvent,
	BookAuthorRemovedEvent,
	BookRemovedEvent,
	BookRemovedEventSubscriber,
} from './domain/events';

export const CommandHandlers: Type<ICommandHandler>[] = [
	AddBookCommandHandler,
	AddBookAuthorCommandHandler,
	RemoveBookAuthorCommandHandler,
	RemoveBookCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [GetBookByIdQueryHandler];

export const SnapshotRepositories: Type<SnapshotRepository>[] = [BookSnapshotRepository];

export const EventPublishers = [CustomEventPublisher];

export const EventSubscribers: Type<IEventSubscriber>[] = [BookAddedEventSubscriber, BookRemovedEventSubscriber];

export const Events: Type<IEvent>[] = [BookAddedEvent, BookAuthorAddedEvent, BookAuthorRemovedEvent, BookRemovedEvent];

export const AggregateRepositories = [BookRepository];

export const Controllers: Type<Controller>[] = [BookController];
