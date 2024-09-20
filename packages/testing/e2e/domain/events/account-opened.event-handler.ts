import { type EventEnvelope, EventHandler, type IEventHandler } from '@ocoda/event-sourcing';
import { AccountOpenedEvent } from './account-opened.event';

@EventHandler(AccountOpenedEvent)
export class AccountOpenedEventHandler implements IEventHandler {
	handle({ metadata }: EventEnvelope<AccountOpenedEvent>) {
		return;
	}
}
