import { EventName, IEvent } from '@ocoda/event-sourcing';

@EventName('account-credited')
export class AccountCreditedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}
