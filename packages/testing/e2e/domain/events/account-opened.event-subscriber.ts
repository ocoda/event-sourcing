import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { AccountOpenedEvent } from './account-opened.event.js';

@EventSubscriber(AccountOpenedEvent)
export class AccountOpenedEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<AccountOpenedEvent>) {
		return;
	}
}
