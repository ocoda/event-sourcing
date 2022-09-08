import { Aggregate, Id, ISnapshot, SnapshotEnvelope } from '../../../lib';

describe(SnapshotEnvelope, () => {
	const now = new Date();

	class AccountId extends Id {}
	class Account extends Aggregate {
		constructor(public id: AccountId, public balance: number, public openedOn: Date, public closedOn?: Date) {
			super();
		}
	}

	beforeAll(() => jest.spyOn(global.Date, 'now').mockImplementationOnce(() => now.valueOf()));

	it('should create a snapshot-envelope', () => {
		const accountId = AccountId.generate();
		const accountSnapshot: ISnapshot<Account> = {
			id: accountId,
			balance: 0,
			openedOn: new Date(),
			closedOn: undefined,
		};

		const envelope = SnapshotEnvelope.new(accountId, 1, 'account', accountSnapshot);

		expect(envelope.snapshotId).toBeDefined();
		expect(envelope.payload).toEqual(accountSnapshot);
		expect(envelope.metadata.aggregateId).toEqual(accountId.value);
		expect(envelope.metadata.sequence).toBe(1);
		expect(envelope.metadata.registeredOn).toEqual(now.valueOf());
	});
});
