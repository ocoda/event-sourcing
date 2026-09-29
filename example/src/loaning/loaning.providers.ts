import type { Type } from '@nestjs/common';
import type { ICommandHandler, IEvent, IQueryHandler, SnapshotRepository } from '@ocoda/event-sourcing';
import { BookLoanController } from './application/book-loan.controller.js';
import {
	CreateBookLoanCommandHandler,
	ExtendBookLoanCommandHandler,
	ReturnBookLoanCommandHandler,
} from './application/commands/index.js';
import { GetBookLoanByIdQueryHandler } from './application/queries/index.js';
import { BookLoanRepository, BookLoanSnapshotRepository } from './application/repositories/index.js';
import { BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent } from './domain/events/index.js';

export const CommandHandlers: Type<ICommandHandler>[] = [
	CreateBookLoanCommandHandler,
	ExtendBookLoanCommandHandler,
	ReturnBookLoanCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [GetBookLoanByIdQueryHandler];

export const SnapshotRepositories: Type<SnapshotRepository>[] = [BookLoanSnapshotRepository];

export const Events: Type<IEvent>[] = [BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent];

export const AggregateRepositories = [BookLoanRepository];

export const Controllers: Type<object>[] = [BookLoanController];
