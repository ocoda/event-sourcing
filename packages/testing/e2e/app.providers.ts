import type { Type } from '@nestjs/common';
import type { ICommandHandler, IEventHandler, IQueryHandler, SnapshotHandler } from '@ocoda/event-sourcing';
import {
	AccountRepository,
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	CustomEventPublisher,
	DebitAccountCommandHandler,
	GetAccountByIdQueryHandler,
	GetAccountsByIdsQueryHandler,
	GetAccountsQueryHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
} from './application';
import {
	AccountClosedEvent,
	AccountClosedEventHandler,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOpenedEventHandler,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
	AccountSnapshotHandler,
} from './domain';

export const CommandHandlers: Type<ICommandHandler>[] = [
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	DebitAccountCommandHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [
	GetAccountByIdQueryHandler,
	GetAccountsByIdsQueryHandler,
	GetAccountsQueryHandler,
];

export const SnapshotHandlers: Type<SnapshotHandler>[] = [AccountSnapshotHandler];

export const EventHandlers: Type<IEventHandler>[] = [AccountOpenedEventHandler, AccountClosedEventHandler];

export const EventPublishers = [CustomEventPublisher];

export const Events = [
	AccountOpenedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
	AccountClosedEvent,
];

export const AggregateRepositories = [AccountRepository];

export const testProviders = [
	...AggregateRepositories,
	...CommandHandlers,
	...QueryHandlers,
	...SnapshotHandlers,
	...EventHandlers,
	...EventPublishers,
];
