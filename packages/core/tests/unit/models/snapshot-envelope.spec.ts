import { AggregateRoot, type ISnapshot, SnapshotEnvelope, UUID } from '@ocoda/event-sourcing';

describe(SnapshotEnvelope, () => {
	class AccountId extends UUID {}
	class Account extends AggregateRoot {
		constructor(
			public id: AccountId,
			public balance: number,
			public openedOn: Date,
			public closedOn?: Date,
		) {
			super();
		}
	}

	it('should create a snapshot-envelope', () => {
		const accountId = AccountId.generate();
		const accountSnapshot: ISnapshot<Account> = {
			id: accountId,
			balance: 0,
			openedOn: new Date(),
			closedOn: undefined,
		};

		const envelope = SnapshotEnvelope.create(accountSnapshot, {
			aggregateId: accountId.value,
			version: 1,
		});

		expect(envelope.payload).toEqual(accountSnapshot);
		expect(envelope.metadata.aggregateId).toEqual(accountId.value);
		expect(envelope.metadata.version).toBe(1);
		expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
	});
});
