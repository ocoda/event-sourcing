import type { IEventSerializer } from '@ocoda/event-sourcing';
import type { IEventPayload } from '@ocoda/event-sourcing';
import { EventSerializer } from '@ocoda/event-sourcing';
import { AccountOpenedEvent } from './account-opened.event';

@EventSerializer(AccountOpenedEvent)
export class AccountOpenedEventSerializer implements IEventSerializer {
	serialize({ accountId, openedOn, balance, accountOwnerIds }: AccountOpenedEvent): IEventPayload<AccountOpenedEvent> {
		return {
			accountId,
			openedOn: openedOn.toISOString(),
			balance,
			accountOwnerIds,
		};
	}

	deserialize({
		accountId,
		openedOn,
		balance,
		accountOwnerIds,
	}: IEventPayload<AccountOpenedEvent>): AccountOpenedEvent {
		const openedOnDate = openedOn && new Date(openedOn);
		if (!openedOnDate) {
			throw new Error('Invalid date');
		}

		return new AccountOpenedEvent(accountId, balance, openedOn, accountOwnerIds);
	}
}
