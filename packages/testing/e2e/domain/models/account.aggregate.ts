import { Aggregate, AggregateRoot, DomainException, EventHandler, UUID } from '@ocoda/event-sourcing';
import {
	AccountClosedEvent,
	AccountCreditedEvent,
	AccountDebitedEvent,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountOwnerRemovedEvent,
	AccountTransferFailedEvent,
	AccountTransferSucceededEvent,
} from '../events';

export class AccountId extends UUID {}
export class AccountOwnerId extends UUID {}

export class AccountAlreadyClosedException extends DomainException {
	static because(accountId: AccountId): AccountAlreadyClosedException {
		return new AccountAlreadyClosedException('Account is already closed', accountId);
	}
}

export class AccountAlreadyOpenException extends DomainException {
	static because(accountId: AccountId): AccountAlreadyOpenException {
		return new AccountAlreadyOpenException('Account is already open', accountId);
	}
}

export class AccountInsufficientFundsException extends DomainException {
	static because(accountId: AccountId, amount: number): AccountInsufficientFundsException {
		return new AccountInsufficientFundsException(`Insufficient funds to debit ${amount}`, accountId);
	}
}

export class AccountOwnerAlreadyExistsException extends DomainException {
	static because(accountId: AccountId, ownerId: AccountOwnerId): AccountOwnerAlreadyExistsException {
		return new AccountOwnerAlreadyExistsException(`Account owner already exists (${ownerId.value})`, accountId);
	}
}

export class AccountOwnerNotFoundException extends DomainException {
	static because(accountId: AccountId, ownerId: AccountOwnerId): AccountOwnerNotFoundException {
		return new AccountOwnerNotFoundException(`Account owner not found (${ownerId.value})`, accountId);
	}
}

export class AccountInvalidAmountException extends DomainException {
	static because(accountId: AccountId, amount: number): AccountInvalidAmountException {
		return new AccountInvalidAmountException(`Amount must be greater than zero (${amount})`, accountId);
	}
}

@Aggregate({ streamName: 'account' })
export class Account extends AggregateRoot {
	public id: AccountId;
	public ownerIds: AccountOwnerId[];
	public balance: number;
	public openedOn: Date;
	public closedOn: Date;

	public static open(accountId: AccountId, accountOwnerIds?: AccountOwnerId[]) {
		const account = new Account();

		if (account.openedOn) {
			throw AccountAlreadyOpenException.because(accountId);
		}

		account.applyEvent(new AccountOpenedEvent(accountId.value, accountOwnerIds?.map(({ value }) => value) || []));

		return account;
	}

	public addOwner(accountOwnerId: AccountOwnerId) {
		if (this.closedOn) {
			throw AccountAlreadyClosedException.because(this.id);
		}
		if (this.ownerIds.some(({ value }) => value === accountOwnerId.value)) {
			throw AccountOwnerAlreadyExistsException.because(this.id, accountOwnerId);
		}
		this.applyEvent(new AccountOwnerAddedEvent(accountOwnerId.value));
	}

	public removeOwner(accountOwnerId: AccountOwnerId) {
		if (this.closedOn) {
			throw AccountAlreadyClosedException.because(this.id);
		}
		if (!this.ownerIds.some(({ value }) => value === accountOwnerId.value)) {
			throw AccountOwnerNotFoundException.because(this.id, accountOwnerId);
		}
		this.applyEvent(new AccountOwnerRemovedEvent(accountOwnerId.value));
	}

	public credit(amount: number) {
		if (this.closedOn) {
			throw AccountAlreadyClosedException.because(this.id);
		}
		if (amount <= 0) {
			throw AccountInvalidAmountException.because(this.id, amount);
		}
		this.applyEvent(new AccountCreditedEvent(amount));
	}

	public debit(amount: number) {
		if (this.closedOn) {
			throw AccountAlreadyClosedException.because(this.id);
		}
		if (amount <= 0) {
			throw AccountInvalidAmountException.because(this.id, amount);
		}
		if (amount > this.balance) {
			throw AccountInsufficientFundsException.because(this.id, amount);
		}
		this.applyEvent(new AccountDebitedEvent(amount));
	}

	public close() {
		if (this.closedOn) {
			throw AccountAlreadyClosedException.because(this.id);
		}
		this.applyEvent(new AccountClosedEvent());
	}

	@EventHandler(AccountOpenedEvent)
	applyAccountOpenedEvent(event: AccountOpenedEvent) {
		this.id = AccountId.from(event.accountId);
		this.ownerIds = (event.accountOwnerIds ?? []).map(AccountOwnerId.from);
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

	@EventHandler(AccountTransferSucceededEvent)
	applyAccountTransferSucceededEvent(_event: AccountTransferSucceededEvent) {
		return;
	}

	@EventHandler(AccountTransferFailedEvent)
	applyAccountTransferFailedEvent(_event: AccountTransferFailedEvent) {
		return;
	}
}
