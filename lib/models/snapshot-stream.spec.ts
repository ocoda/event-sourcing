import { Aggregate } from './aggregate';
import { Id } from './id';
import { SnapshotStream } from './snapshot-stream';

describe(SnapshotStream, () => {
  class Account extends Aggregate {}
  class AccountId extends Id {}

  it('should create a SnapshotStream from an Aggregate class', () => {
    const accountId = AccountId.generate();
    const snapshotStream = SnapshotStream.for(Account, accountId);

    expect(snapshotStream).toEqual({ aggregate: Account, id: accountId });
    expect(snapshotStream.name).toBe(`Account-${accountId.value}`);
  });

  it('should create a SnapshotStream from an Aggregate instance', () => {
    const account = new Account();
    const accountId = AccountId.generate();
    const snapshotStream = SnapshotStream.for(account, accountId);

    expect(snapshotStream).toEqual({ aggregate: Account, id: accountId });
    expect(snapshotStream.name).toBe(`Account-${accountId.value}`);
  });
});
