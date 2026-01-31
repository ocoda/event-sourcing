import { AggregateRoot, MissingEventHandlerException } from '@ocoda/event-sourcing';

describe(AggregateRoot, () => {
	class BalanceChangedEvent {
		constructor(public readonly amount: number) {}
	}

	class Account extends AggregateRoot {
		public balance = 0;

		onBalanceChanged(event: BalanceChangedEvent) {
			this.balance += event.amount;
		}
	}

	it('applyEvent tracks version and commits', () => {
		const account = new Account();
		jest.spyOn(account as any, 'getEventHandler').mockReturnValue(account.onBalanceChanged);
		account.applyEvent(new BalanceChangedEvent(5));

		expect(account.version).toBe(1);
		expect(account.balance).toBe(5);
		expect(account.commit()).toHaveLength(1);
		expect(account.commit()).toHaveLength(0);
	});

	it('applyEvent skips commit for history events', () => {
		const account = new Account();
		jest.spyOn(account as any, 'getEventHandler').mockReturnValue(account.onBalanceChanged);
		account.applyEvent(new BalanceChangedEvent(10), true);

		expect(account.commit()).toHaveLength(0);
	});

	it('throws when no handler exists', () => {
		class MissingHandlerEvent {}
		const account = new Account();

		expect(() => account.applyEvent(new MissingHandlerEvent() as any)).toThrow(MissingEventHandlerException);
	});
});
