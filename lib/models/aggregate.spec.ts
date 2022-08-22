import { Aggregate } from './aggregate';
import { IEvent, ISnapshot } from '../interfaces';

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

    createSnapshot(): ISnapshot {
      return { version: this.version, balance: this.balance };
    }

    loadSnapshot(snapshot: { version: number; balance: number }) {
      this.version = snapshot.version;
      this.balance = snapshot.balance;
    }
  }

  it('should apply events', () => {
    const account = new Account();

    account.apply(new AccountOpenedEvent());
    expect(account.version).toBe(1);
    expect(account.balance).toBe(0);

    account.apply(new MoneyDepositedEvent(50));
    expect(account.version).toBe(2);
    expect(account.balance).toBe(50);

    account.apply(new MoneyWithdrawnEvent(20));
    expect(account.version).toBe(3);
    expect(account.balance).toBe(30);
  });

  it('should create snapshots', () => {
    const account = new Account();

    account.apply(new AccountOpenedEvent());
    account.apply(new MoneyDepositedEvent(50));
    account.apply(new MoneyWithdrawnEvent(20));

    const snapshot = account.createSnapshot();

    expect(snapshot).toEqual({ version: 3, balance: 30 });
  });

  it('should apply snapshots', () => {
    const account = new Account();

    const snapshot = { version: 5, balance: 123 };
    account.loadSnapshot(snapshot);

    expect(account.version).toBe(5);
    expect(account.balance).toBe(123);
  });
});
