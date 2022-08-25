import { Aggregate } from './aggregate';
import { Id } from './id';
import { SnapshotStream } from './snapshot-stream';

describe(SnapshotStream, () => {
  class Account extends Aggregate {}
  class AccountId extends Id {}

  it('should create a snapshot-stream from an Aggregate class', () => {
    const accountId = AccountId.generate();
    const snapshotStream = SnapshotStream.for(Account, accountId);

    expect(snapshotStream).toBe(`Account-${accountId.value}`);
  });

  it('should create a snapshot-stream from an Aggregate instance', () => {
    const account = new Account();
    const accountId = AccountId.generate();
    const eventStream = SnapshotStream.for(account, accountId);

    expect(eventStream).toBe(`Account-${accountId.value}`);
  });
});
