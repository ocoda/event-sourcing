import { Aggregate } from './aggregate';
import { IEvent, ISnapshot } from '../interfaces';

describe(Aggregate, () => {
	class AccountOpenedEvent implements IEvent {}
	class AccountCreditedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}
	class AccountDebitedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}

	class Account extends Aggregate {
		public balance: number;

		static open() {
			const account = new Account();
			account.applyEvent(new AccountOpenedEvent());
			return account;
		}

		public credit(amount: number) {
			this.applyEvent(new AccountCreditedEvent(amount));
		}

		public debit(amount: number) {
			this.applyEvent(new AccountDebitedEvent(amount));
		}

		onAccountOpenedEvent() {
			this.balance = 0;
		}

		onAccountCreditedEvent(event: AccountCreditedEvent) {
			this.balance += event.amount;
		}

		onAccountDebitedEvent(event: AccountDebitedEvent) {
			this.balance -= event.amount;
		}
	}

	it('should apply events', () => {
		const account = Account.open();
		expect(account.version).toBe(1);
		expect(account.balance).toBe(0);

		account.credit(50);
		expect(account.version).toBe(2);
		expect(account.balance).toBe(50);

		account.debit(20);
		expect(account.version).toBe(3);
		expect(account.balance).toBe(30);
	});

	it('should create snapshots', () => {
		const account = Account.open();

		account.credit(50);
		account.debit(20);

		const snapshot = account.snapshot;

		expect(snapshot).toEqual({ version: 3, balance: 30 });
	});

	it('should apply snapshots', () => {
		const account = Account.open();

		for (let i = 0; i < 4; i++) {
			account.credit(10);
		}

		const accountFromSnapshot = new Account();
		accountFromSnapshot.loadFromSnapshot(account.snapshot, account.version);

		expect(accountFromSnapshot.version).toBe(account.version);
		expect(accountFromSnapshot.balance).toBe(account.balance);
	});

	it('should commit events', () => {
		const account = Account.open();
		account.credit(50);
		account.debit(20);

		expect(account.commit()).toEqual([
			new AccountOpenedEvent(),
			new AccountCreditedEvent(50),
			new AccountDebitedEvent(20),
		]);
	});
});
