import { EventName, IEvent } from '@ocoda/event-sourcing';

@EventName('account-debited')
export class AccountDebitedEvent implements IEvent {
  constructor(public readonly amount: number) {}
}
