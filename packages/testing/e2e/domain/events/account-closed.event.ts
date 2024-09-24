import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-closed')
export class AccountClosedEvent implements IEvent {}
