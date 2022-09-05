import {
  AccountClosedEvent,
  AccountCreditedEvent,
  AccountDebitedEvent,
  AccountOpenedEvent,
  AccountOwnerAddedEvent,
  AccountOwnerRemovedEvent,
} from './domain/events';
import { AccountSnapshotHandler } from './domain/models/account.snapshot-handler';
import {
  AddAccountOwnerCommandHandler,
  OpenAccountCommandHandler,
} from './application/commands';
import {
  ICommandHandler,
  IQueryHandler,
  ISnapshotHandler,
} from '@ocoda/event-sourcing';
import { Type } from '@nestjs/common';
import { AccountRepository } from './application/repositories';

export const CommandHandlers: Type<ICommandHandler>[] = [
  OpenAccountCommandHandler,
  AddAccountOwnerCommandHandler,
];

export const QueryHandlers: Type<IQueryHandler>[] = [];

export const SnapshotHandlers: Type<ISnapshotHandler>[] = [
  AccountSnapshotHandler,
];

export const Events = [
  AccountOpenedEvent,
  AccountCreditedEvent,
  AccountDebitedEvent,
  AccountOwnerAddedEvent,
  AccountOwnerRemovedEvent,
  AccountClosedEvent,
];

export const AggregateRepositories = [AccountRepository];
