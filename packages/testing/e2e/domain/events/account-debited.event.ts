import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-debited')
export class AccountDebitedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}
