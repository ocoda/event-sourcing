import { Event, type IEvent } from '@ocoda/event-sourcing';

@Event('account-transfer-succeeded')
export class AccountTransferSucceededEvent implements IEvent {
	constructor(
		public readonly fromAccountId: string,
		public readonly toAccountId: string,
		public readonly amount: number,
	) {}
}
