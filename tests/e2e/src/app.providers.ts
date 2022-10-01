import { Type } from '@nestjs/common';
import { ICommandHandler, IEventListener, IQueryHandler, SnapshotHandler } from '@ocoda/event-sourcing';
import {
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	DebitAccountCommandHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
} from './application/commands';
import { AccountRepository } from './application/repositories';
import {
	AccountClosedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountEventListener,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
} from './domain/events';
import { AccountSnapshotHandler } from './domain/models';

export const CommandHandlers: Type<ICommandHandler>[] = [
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	DebitAccountCommandHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [];

export const SnapshotHandlers: Type<SnapshotHandler>[] = [AccountSnapshotHandler];

export const EventListeners: Type<IEventListener>[] = [AccountEventListener];

export const Events = [
	AccountOpenedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
	AccountClosedEvent,
];

export const AggregateRepositories = [AccountRepository];
