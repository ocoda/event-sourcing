import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-credited')
export class AccountCreditedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}
