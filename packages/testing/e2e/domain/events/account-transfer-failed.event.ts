import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-transfer-failed')
export class AccountTransferFailedEvent implements IEvent {
	constructor(
		public readonly fromAccountId: string,
		public readonly toAccountId: string,
		public readonly amount: number,
		public readonly reason: string,
	) {}
}
