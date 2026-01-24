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
	TransferBetweenAccountsCommandHandler,
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
	AccountTransferFailedEvent,
	AccountTransferSucceededEvent,
	AccountTransferSucceededEventSubscriber,
} from './domain';

export const CommandHandlers: Type<ICommandHandler>[] = [
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	DebitAccountCommandHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
	TransferBetweenAccountsCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [
	GetAccountByIdQueryHandler,
	GetAccountsByIdsQueryHandler,
	GetAccountsQueryHandler,
];

export const SnapshotRepositories: Type<SnapshotRepository>[] = [AccountSnapshotRepository];

export const EventSubscribers: Type<IEventSubscriber>[] = [
	AccountOpenedEventSubscriber,
	AccountClosedEventSubscriber,
	AccountTransferSucceededEventSubscriber,
];

export const EventPublishers = [CustomEventPublisher];

export const Events = [
	AccountOpenedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
	AccountClosedEvent,
	AccountTransferSucceededEvent,
	AccountTransferFailedEvent,
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
