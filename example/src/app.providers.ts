import type { Type } from '@nestjs/common';
import type { ICommandHandler, IEventSubscriber, IQueryHandler, SnapshotHandler } from '@ocoda/event-sourcing';
import {
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	DebitAccountCommandHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
	TransferBetweenAccountsCommandHandler,
} from './application/commands';
import { CustomEventPublisher } from './application/publishers';
import { GetAccountByIdQueryHandler } from './application/queries';
import { AccountRepository } from './application/repositories';
import {
	AccountClosedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
} from './domain/events';
import { AccountClosedEventSubscriber, AccountOpenedEventSubscriber } from './domain/events';
import { AccountSnapshotHandler } from './domain/models';

export const CommandHandlers: Type<ICommandHandler>[] = [
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	DebitAccountCommandHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
	TransferBetweenAccountsCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [GetAccountByIdQueryHandler];

export const SnapshotHandlers: Type<SnapshotHandler>[] = [AccountSnapshotHandler];

export const EventPublishers = [CustomEventPublisher];

export const EventSubscribers: Type<IEventSubscriber>[] = [AccountOpenedEventSubscriber, AccountClosedEventSubscriber];

export const Events = [
	AccountOpenedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
	AccountClosedEvent,
];

export const AggregateRepositories = [AccountRepository];
