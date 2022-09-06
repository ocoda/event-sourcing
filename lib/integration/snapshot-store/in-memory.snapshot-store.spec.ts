import { InMemorySnapshotStore } from './in-memory.snapshot-store';
import { Aggregate, Id, SnapshotStream, SnapshotEnvelope } from '../../models';
import { StreamReadingDirection } from '../../constants';

class Account extends Aggregate {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

describe(InMemorySnapshotStore, () => {
	const accountId = AccountId.generate();

	const snapshots = [
		SnapshotEnvelope.new<Account>(accountId, 10, 'account', { balance: 50 }),
		SnapshotEnvelope.new<Account>(accountId, 20, 'account', { balance: 20 }),
		SnapshotEnvelope.new<Account>(accountId, 30, 'account', { balance: 60 }),
		SnapshotEnvelope.new<Account>(accountId, 40, 'account', { balance: 100 }),
		SnapshotEnvelope.new<Account>(accountId, 50, 'account', { balance: 70 }),
		SnapshotEnvelope.new<Account>(accountId, 60, 'account', { balance: 150 }),
	];

	it('should append snapshots', async () => {
		const snapshotStore = new InMemorySnapshotStore();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		snapshotStore.appendSnapshots(snapshotStream, ...snapshots);

		expect(snapshotStore).toHaveProperty('snapshotCollection', new Map([[snapshotStream.name, snapshots]]));
	});

	it('should retrieve snapshots forward', async () => {
		const snapshotStore = new InMemorySnapshotStore();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		snapshotStore.appendSnapshots(snapshotStream, ...snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve snapshots backwards', async () => {
		const snapshotStore = new InMemorySnapshotStore();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		snapshotStore.appendSnapshots(snapshotStream, ...snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', async () => {
		const snapshotStore = new InMemorySnapshotStore();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		snapshotStore.appendSnapshots(snapshotStream, ...snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 40);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 40));
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		const snapshotStore = new InMemorySnapshotStore();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		snapshotStore.appendSnapshots(snapshotStream, ...snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 30, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 30).reverse());
	});

	it('should retrieve the last snapshot', async () => {
		const snapshotStore = new InMemorySnapshotStore();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		snapshotStore.appendSnapshots(snapshotStream, ...snapshots);

		const resolvedSnapshot = snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there are no snapshots', async () => {
		const snapshotStore = new InMemorySnapshotStore();
		const snapshotStream = SnapshotStream.for(Account, accountId);

		expect(snapshotStore.getSnapshots(snapshotStream)).toBeUndefined();
		expect(snapshotStore.getSnapshot(snapshotStream, 50)).toBeUndefined();
		expect(snapshotStore.getLastSnapshot(snapshotStream)).toBeUndefined();
	});
});
