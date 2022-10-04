import { Aggregate, AggregateRoot, Id } from '@ocoda/event-sourcing';
import {
	AccountClosedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
} from '../events';

export class AccountId extends Id {}
export class AccountOwnerId extends Id {}

@Aggregate({ streamName: 'account' })
export class Account extends AggregateRoot {
	public id: AccountId;
	public ownerIds: AccountOwnerId[];
	public balance: number;
	public openedOn: Date;
	public closedOn: Date;

	public static open(accountId: AccountId, accountOwnerIds?: AccountOwnerId[]) {
		const account = new Account();

		account.applyEvent(
			new AccountOpenedEvent(accountId.value, 0, new Date(), accountOwnerIds?.map(({ value }) => value) || []),
		);

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

	onAccountOpenedEvent(event: AccountOpenedEvent) {
		this.id = AccountId.from(event.accountId);
		this.balance = event.balance;
		this.openedOn = event.openedOn;
		this.ownerIds = event.accountOwnerIds?.map(AccountOwnerId.from);
	}

	onAccountOwnerAddedEvent(event: AccountOwnerAddedEvent) {
		this.ownerIds.push(AccountOwnerId.from(event.accountOwnerId));
	}

	onAccountOwnerRemovedEvent(event: AccountOwnerAddedEvent) {
		this.ownerIds = this.ownerIds.filter(({ value }) => value !== event.accountOwnerId);
	}

	onAccountCreditedEvent(event: AccountCreditedEvent) {
		this.balance += event.amount;
	}

	onAccountDebitedEvent(event: AccountDebitedEvent) {
		this.balance -= event.amount;
	}

	onAccountClosedEvent() {
		this.closedOn = new Date();
	}
}
