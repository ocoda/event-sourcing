import { Aggregate, AggregateRoot, MissingAggregateMetadataException, SnapshotStream, UUID } from '../../../lib';

describe(SnapshotStream, () => {
	@Aggregate({ streamName: 'account' }) class Account extends AggregateRoot {}
	class AccountId extends UUID {}

	it('should create a SnapshotStream from an Aggregate class', () => {
		const accountId = AccountId.generate();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		expect(snapshotStream.aggregateId).toBe(accountId.value);
		expect(snapshotStream.streamId).toBe(`account-${accountId.value}`);
	});

	it('should create a SnapshotStream from an Aggregate instance', () => {
		const account = new Account();
		const accountId = AccountId.generate();
		const snapshotStream = SnapshotStream.for(account, accountId);

		expect(snapshotStream.aggregateId).toBe(accountId.value);
		expect(snapshotStream.streamId).toBe(`account-${accountId.value}`);
	});

	it('should throw when creating a snapshot-stream for an undecorated aggregate', () => {
		class FooId extends UUID {}
		class Foo extends AggregateRoot {}

		expect(() => SnapshotStream.for(Foo, FooId.generate())).toThrow(new MissingAggregateMetadataException(Foo));
	});
});
