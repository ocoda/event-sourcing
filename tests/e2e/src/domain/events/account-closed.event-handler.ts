import { EventEnvelope, EventHandler, IEventHandler } from '@ocoda/event-sourcing';
import { AccountClosedEvent } from './account-closed.event';

@EventHandler(AccountClosedEvent)
export class AccountClosedEventHandler implements IEventHandler {
	handle({ metadata }: EventEnvelope<AccountClosedEvent>) {
		return;
	}
}
