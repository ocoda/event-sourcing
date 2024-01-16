import { Event, IEvent } from '@ocoda/event-sourcing';

@Event('account-opened')
export class AccountOpenedEvent implements IEvent {
	constructor(
		public readonly accountId: string,
		public readonly accountOwnerIds?: string[],
	) {}
}
