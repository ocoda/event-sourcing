import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-owner-added')
export class AccountOwnerAddedEvent implements IEvent {
	constructor(public readonly accountOwnerId: string) {}
}
