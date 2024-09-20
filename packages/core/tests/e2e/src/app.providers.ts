import type { Type } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { type ICommandHandler, type IEventHandler, type IQueryHandler, SnapshotHandler } from '@ocoda/event-sourcing';
import {
	AddAccountOwnerCommandHandler,
	CloseAccountCommandHandler,
	CreditAccountCommandHandler,
	DebitAccountCommandHandler,
	OpenAccountCommandHandler,
	RemoveAccountOwnerCommandHandler,
} from './application/commands';
import { CustomEventPublisher } from './application/publishers';
import { GetAccountByIdQueryHandler, GetAccountsQueryHandler } from './application/queries';
import { AccountRepository } from './application/repositories';
import {
	AccountClosedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
} from './domain/events';
import { AccountClosedEventHandler } from './domain/events/account-closed.event-handler';
import { AccountOpenedEventHandler } from './domain/events/account-opened.event-handler';
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

export const QueryHandlers: Type<IQueryHandler>[] = [GetAccountByIdQueryHandler, GetAccountsQueryHandler];

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
