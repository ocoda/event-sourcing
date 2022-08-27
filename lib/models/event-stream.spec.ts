import { Aggregate } from './aggregate';
import { EventStream } from './event-stream';
import { Id } from './id';

describe(EventStream, () => {
  class Account extends Aggregate {}
  class AccountId extends Id {}

  it('should create an EventStream from an Aggregate class', () => {
    const accountId = AccountId.generate();
    const eventStream = EventStream.for(Account, accountId);

    expect(eventStream).toEqual({ aggregate: Account, id: accountId });
    expect(eventStream.name).toBe(`Account-${accountId.value}`);
  });

  it('should create an EventStream from an Aggregate instance', () => {
    const account = new Account();
    const accountId = AccountId.generate();
    const eventStream = EventStream.for(account, accountId);

    expect(eventStream).toEqual({ aggregate: Account, id: accountId });
    expect(eventStream.name).toBe(`Account-${accountId.value}`);
  });
});
