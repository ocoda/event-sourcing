import { Aggregate } from './aggregate';
import { IEvent } from '../interfaces';

describe(Aggregate, () => {
	class AccountOpenedEvent implements IEvent {}
	class MoneyDepositedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}
	class MoneyWithdrawnEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}

	class Account extends Aggregate {
		public balance: number;

		onAccountOpenedEvent(event: AccountOpenedEvent) {
			this.balance = 0;
		}

		onMoneyDepositedEvent(event: MoneyDepositedEvent) {
			this.balance += event.amount;
		}

		onMoneyWithdrawnEvent(event: MoneyWithdrawnEvent) {
			this.balance -= event.amount;
		}
	}

	it('should apply events', () => {
		const account = new Account();

		account.applyEvent(new AccountOpenedEvent());
		expect(account.version).toBe(1);
		expect(account.balance).toBe(0);

		account.applyEvent(new MoneyDepositedEvent(50));
		expect(account.version).toBe(2);
		expect(account.balance).toBe(50);

		account.applyEvent(new MoneyWithdrawnEvent(20));
		expect(account.version).toBe(3);
		expect(account.balance).toBe(30);
	});

	it('should create snapshots', () => {
		const account = new Account();

		account.applyEvent(new AccountOpenedEvent());
		account.applyEvent(new MoneyDepositedEvent(50));
		account.applyEvent(new MoneyWithdrawnEvent(20));

		const snapshot = account.snapshot;

		expect(snapshot).toEqual({ version: 3, balance: 30 });
	});

	it('should apply snapshots', () => {
		const account = new Account();
		account.useSnapshots();

		const snapshot = { version: 5, balance: 123 };
		account.loadFromHistory([], snapshot);

		expect(account.version).toBe(5);
		expect(account.balance).toBe(123);
	});

	it('should commit events', () => {
		const account = new Account();

		const events = [new AccountOpenedEvent(), new MoneyDepositedEvent(50), new MoneyWithdrawnEvent(20)];

		events.forEach((event) => account.applyEvent(event));

		expect(account.commit()).toEqual(events);
	});
});
