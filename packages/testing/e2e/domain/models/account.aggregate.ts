import { Aggregate, AggregateRoot, EventHandler, UUID } from '@ocoda/event-sourcing';
import {
	AccountClosedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
} from '../events';

export class AccountId extends UUID {}
export class AccountOwnerId extends UUID {}

@Aggregate({ streamName: 'account' })
export class Account extends AggregateRoot {
	public id: AccountId;
	public ownerIds: AccountOwnerId[];
	public balance: number;
	public openedOn: Date;
	public closedOn: Date;

	public static open(accountId: AccountId, accountOwnerIds?: AccountOwnerId[]) {
		const account = new Account();

		account.applyEvent(new AccountOpenedEvent(accountId.value, accountOwnerIds?.map(({ value }) => value) || []));

		return account;
	}

	public addOwner(accountOwnerId: AccountOwnerId) {
		this.applyEvent(new AccountOwnerAddedEvent(accountOwnerId.value));
	}

	public removeOwner(accountOwnerId: AccountOwnerId) {
		this.applyEvent(new AccountOwnerRemovedEvent(accountOwnerId.value));
	}

	public credit(amount: number) {
		this.applyEvent(new AccountCreditedEvent(amount));
	}

	public debit(amount: number) {
		this.applyEvent(new AccountDebitedEvent(amount));
	}

	public close() {
		this.applyEvent(new AccountClosedEvent());
	}

	@EventHandler(AccountOpenedEvent)
	applyAccountOpenedEvent(event: AccountOpenedEvent) {
		this.id = AccountId.from(event.accountId);
		this.ownerIds = event.accountOwnerIds.map(AccountOwnerId.from);
		this.balance = 0;
		this.openedOn = new Date();
	}

	@EventHandler(AccountOwnerAddedEvent)
	applyAccountOwnerAddedEvent(event: AccountOwnerAddedEvent) {
		this.ownerIds.push(AccountOwnerId.from(event.accountOwnerId));
	}

	@EventHandler(AccountOwnerRemovedEvent)
	applyAccountOwnerRemovedEvent(event: AccountOwnerAddedEvent) {
		this.ownerIds = this.ownerIds.filter(({ value }) => value !== event.accountOwnerId);
	}

	@EventHandler(AccountCreditedEvent)
	applyAccountCreditedEvent(event: AccountCreditedEvent) {
		this.balance += event.amount;
	}

	@EventHandler(AccountDebitedEvent)
	applyAccountDebitedEvent(event: AccountDebitedEvent) {
		this.balance -= event.amount;
	}

	@EventHandler(AccountClosedEvent)
	applyAccountClosedEvent() {
		this.closedOn = new Date();
	}
}
