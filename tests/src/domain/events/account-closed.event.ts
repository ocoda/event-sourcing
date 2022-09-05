import { EventName, IEvent } from '@ocoda/event-sourcing';

@EventName('account-closed')
export class AccountClosedEvent implements IEvent {}
