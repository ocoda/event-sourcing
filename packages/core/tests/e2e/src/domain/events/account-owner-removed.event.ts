import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-owner-removed')
export class AccountOwnerRemovedEvent implements IEvent {
	constructor(public readonly accountOwnerId: string) {}
}
