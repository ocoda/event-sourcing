import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { AccountOpenedEvent } from './account-opened.event';

@EventSubscriber(AccountOpenedEvent)
export class AccountOpenedEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<AccountOpenedEvent>) {
		return;
	}
}
