import {
	Aggregate,
	AggregateRoot,
	Event,
	EventHandler,
	type IEvent,
	MissingEventHandlerException,
} from '@ocoda/event-sourcing';

describe(Aggregate, () => {
	@Event()
	class AccountOpenedEvent implements IEvent {}

	@Event()
	class AccountCreditedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}

	@Event()
	class AccountDebitedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}

	@Event()
	class AccountClosedEvent implements IEvent {}

	class Account extends AggregateRoot {
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

		public close() {
			this.applyEvent(new AccountClosedEvent());
		}

		@EventHandler(AccountOpenedEvent)
		applyAccountOpenedEvent() {
			this.balance = 0;
		}

		@EventHandler(AccountCreditedEvent)
		applyAccountCreditedEvent(event: AccountCreditedEvent) {
			this.balance += event.amount;
		}

		@EventHandler(AccountDebitedEvent)
		applyAccountDebitedEvent(event: AccountDebitedEvent) {
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

	it('should throw when applying an event that has no handler', () => {
		const account = Account.open();
		expect(() => account.close()).toThrow(new MissingEventHandlerException(Account, AccountClosedEvent));
	});
});
