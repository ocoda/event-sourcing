import { type EventEnvelope, EventSubscriber, type IEventSubscriber } from '@ocoda/event-sourcing';
import { AccountClosedEvent } from './account-closed.event.js';

@EventSubscriber(AccountClosedEvent)
export class AccountClosedEventSubscriber implements IEventSubscriber {
	handle({ metadata }: EventEnvelope<AccountClosedEvent>) {
		return;
	}
}
