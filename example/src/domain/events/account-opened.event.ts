import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-opened')
export class AccountOpenedEvent implements IEvent {
	constructor(
		public readonly accountId: string,
		public readonly balance: number,
		public readonly openedOn: Date,
		public readonly accountOwnerIds?: string[],
	) {}
}
