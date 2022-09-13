import { Aggregate, AggregateRoot, Id, SnapshotStream } from '../../../lib';

describe(SnapshotStream, () => {
	@Aggregate({ streamName: 'account' })
	class Account extends AggregateRoot {}
	class AccountId extends Id {}

	it('should create a SnapshotStream from an Aggregate class', () => {
		const accountId = AccountId.generate();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		expect(snapshotStream.subject).toBe(`account-${accountId.value}`);
		expect(snapshotStream.collection).toBe('snapshots');
		expect(snapshotStream.pool).toBe('default');
	});

	it('should create a SnapshotStream from an Aggregate instance', () => {
		const account = new Account();
		const accountId = AccountId.generate();
		const snapshotStream = SnapshotStream.for(account, accountId);

		expect(snapshotStream.subject).toBe(`account-${accountId.value}`);
		expect(snapshotStream.collection).toBe('snapshots');
		expect(snapshotStream.pool).toBe('default');
	});
});
