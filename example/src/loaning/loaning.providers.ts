import type { Provider, Type } from '@nestjs/common';
import type { IEvent } from '@ocoda/event-sourcing';
import { BookLoanController } from './application/book-loan.controller.js';
import {
	CreateBookLoanCommandHandler,
	ExtendBookLoanCommandHandler,
	ReturnBookLoanCommandHandler,
} from './application/commands/index.js';
import { GetBookLoanByIdQueryHandler } from './application/queries/index.js';
import { BookLoanRepository, BookLoanSnapshotRepository } from './application/repositories/index.js';
import { BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent } from './domain/events/index.js';

/** The events of loaning, registered by LoaningModule with EventSourcingModule.forFeature(). */
export const Events: Type<IEvent>[] = [BookLoanCreatedEvent, BookLoanExtendedEvent, BookLoanReturnedEvent];

export const Providers: Provider[] = [
	BookLoanRepository,
	BookLoanSnapshotRepository,
	CreateBookLoanCommandHandler,
	ExtendBookLoanCommandHandler,
	ReturnBookLoanCommandHandler,
	GetBookLoanByIdQueryHandler,
];

export const Controllers: Type[] = [BookLoanController];
