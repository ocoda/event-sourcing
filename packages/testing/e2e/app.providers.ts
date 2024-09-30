import type { Type } from '@nestjs/common';
import type { ICommandHandler, IEventSubscriber, IQueryHandler, SnapshotRepository } from '@ocoda/event-sourcing';
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
	AccountClosedEventSubscriber,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOpenedEventSubscriber,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
	AccountSnapshotRepository,
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

export const SnapshotRepositories: Type<SnapshotRepository>[] = [AccountSnapshotRepository];

export const EventSubscribers: Type<IEventSubscriber>[] = [AccountOpenedEventSubscriber, AccountClosedEventSubscriber];

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
	...SnapshotRepositories,
	...EventSubscribers,
	...EventPublishers,
];
