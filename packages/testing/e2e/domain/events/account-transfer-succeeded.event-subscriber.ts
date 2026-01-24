import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { AccountTransferSucceededEvent } from './account-transfer-succeeded.event';

@EventSubscriber(AccountTransferSucceededEvent)
export class AccountTransferSucceededEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<AccountTransferSucceededEvent>) {
		return;
	}
}
