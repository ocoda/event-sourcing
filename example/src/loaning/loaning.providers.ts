import type { Type } from '@nestjs/common';
import type { Controller } from '@nestjs/common/interfaces';
import type { ICommandHandler, IEvent, IQueryHandler, SnapshotRepository } from '@ocoda/event-sourcing';
import {
	CreateBookLoanCommandHandler,
	ExtendBookLoanCommandHandler,
	ReturnBookLoanCommandHandler,
} from './application/commands';
import { GetBookLoanByIdQueryHandler } from './application/queries';
import { BookLoanRepository, BookLoanSnapshotRepository } from './application/repositories';
import { BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent } from './domain/events';
import { BookLoanController } from './application/book-loan.controller';

export const CommandHandlers: Type<ICommandHandler>[] = [
	CreateBookLoanCommandHandler,
	ExtendBookLoanCommandHandler,
	ReturnBookLoanCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [GetBookLoanByIdQueryHandler];

export const SnapshotRepositories: Type<SnapshotRepository>[] = [BookLoanSnapshotRepository];

export const Events: Type<IEvent>[] = [BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent];

export const AggregateRepositories = [BookLoanRepository];

export const Controllers: Type<Controller>[] = [BookLoanController];
