import { Aggregate, AggregateRoot, EventHandler, UUID } from '@ocoda/event-sourcing';
import {
	AccountClosedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
} from '../events';
import { CannotCloseAccountException, InsufficientFundsException } from '../exceptions';

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
		if (this.balance - amount < 0) {
			throw InsufficientFundsException.because("Can't debit more than the account balance", this.id);
		}
		this.applyEvent(new AccountDebitedEvent(amount));
	}

	public close() {
		if (this.balance > 0) {
			throw CannotCloseAccountException.because('Account balance must be zero to close account', this.id);
		}
		if (this.closedOn) {
			throw CannotCloseAccountException.because('Account is already closed', this.id);
		}
		this.applyEvent(new AccountClosedEvent());
	}

	@EventHandler(AccountOpenedEvent)
	onAccountOpenedEvent(event: AccountOpenedEvent) {
		this.id = AccountId.from(event.accountId);
		this.balance = event.balance;
		this.openedOn = event.openedOn;
		this.ownerIds = event.accountOwnerIds?.map(AccountOwnerId.from);
	}

	@EventHandler(AccountOwnerAddedEvent)
	onAccountOwnerAddedEvent(event: AccountOwnerAddedEvent) {
		this.ownerIds.push(AccountOwnerId.from(event.accountOwnerId));
	}

	@EventHandler(AccountOwnerRemovedEvent)
	onAccountOwnerRemovedEvent(event: AccountOwnerAddedEvent) {
		this.ownerIds = this.ownerIds.filter(({ value }) => value !== event.accountOwnerId);
	}

	@EventHandler(AccountCreditedEvent)
	onAccountCreditedEvent(event: AccountCreditedEvent) {
		this.balance += event.amount;
	}

	@EventHandler(AccountDebitedEvent)
	onAccountDebitedEvent(event: AccountDebitedEvent) {
		this.balance -= event.amount;
	}

	@EventHandler(AccountClosedEvent)
	onAccountClosedEvent() {
		this.closedOn = new Date();
	}
}
