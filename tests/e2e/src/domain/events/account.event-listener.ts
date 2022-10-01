import { Injectable } from '@nestjs/common';
import { IEventListener, OnEvent } from '@ocoda/event-sourcing';
import { AccountClosedEvent } from './account-closed.event';
import { AccountCreditedEvent } from './account-credited.event';
import { AccountDebitedEvent } from './account-debited.event';
import { AccountOpenedEvent } from './account-opened.event';
import { AccountOwnerAddedEvent } from './account-owner-added.event';
import { AccountOwnerRemovedEvent } from './account-owner-removed.event';

@Injectable()
export class AccountEventListener implements IEventListener {
	@OnEvent(AccountOpenedEvent)
	handleAccountOpenedEvent(event: AccountOpenedEvent) {}

	@OnEvent(AccountCreditedEvent)
	handleAccountCreditedEvent(event: AccountCreditedEvent) {}

	@OnEvent(AccountDebitedEvent)
	handleAccountDebitedEvent(event: AccountDebitedEvent) {}

	@OnEvent(AccountOwnerAddedEvent)
	handleAccountOwnerAddedEvent(event: AccountOwnerAddedEvent) {}

	@OnEvent(AccountOwnerRemovedEvent)
	handleAccountOwnerRemovedEvent(event: AccountOwnerRemovedEvent) {}

	@OnEvent(AccountClosedEvent)
	handleAccountClosedEvent(event: AccountClosedEvent) {}
}
