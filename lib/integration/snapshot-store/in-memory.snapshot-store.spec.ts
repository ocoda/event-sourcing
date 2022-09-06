import { InMemorySnapshotStore } from './in-memory.snapshot-store';
import { Aggregate, Id, SnapshotStream, SnapshotEnvelope } from '../../models';
import { StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';

class Account extends Aggregate {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

describe(InMemorySnapshotStore, () => {
	const accountId = AccountId.generate();
	const snapshotStream = SnapshotStream.for(Account, accountId);

	let snapshotStore: InMemorySnapshotStore;

	const snapshots = [
		SnapshotEnvelope.new<Account>(accountId, 10, 'account', { balance: 50 }),
		SnapshotEnvelope.new<Account>(accountId, 20, 'account', { balance: 20 }),
		SnapshotEnvelope.new<Account>(accountId, 30, 'account', { balance: 60 }),
		SnapshotEnvelope.new<Account>(accountId, 40, 'account', { balance: 100 }),
		SnapshotEnvelope.new<Account>(accountId, 50, 'account', { balance: 70 }),
		SnapshotEnvelope.new<Account>(accountId, 60, 'account', { balance: 150 }),
	];

	beforeEach(() => {
		snapshotStore = new InMemorySnapshotStore();
	});

	it('should append snapshots', async () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		expect(snapshotStore).toHaveProperty('snapshotCollection', new Map([[snapshotStream.name, snapshots]]));
	});

	it('should retrieve a single snapshot', async () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshot = snapshotStore.getSnapshot(snapshotStream, snapshots[3].metadata.sequence);

		expect(resolvedSnapshot).toEqual(snapshots[3]);
	});

	it("should throw when a snapshot isn't found", async () => {
		expect(() => snapshotStore.getSnapshot(snapshotStream, 5)).toThrow(
			SnapshotNotFoundException.withVersion(snapshotStream.name, 5),
		);
	});

	it('should retrieve snapshots forward', async () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve snapshots backwards', async () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', async () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 40);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 40));
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 30, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 30).reverse());
	});

	it('should retrieve the last snapshot', async () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshot = snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		expect(snapshotStore.getLastSnapshot(snapshotStream)).toBeUndefined();
	});
});
