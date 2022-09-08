import {
	Aggregate,
	Id,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
} from '../../../../lib';
import { InMemorySnapshotStore } from '../../../../lib/integration/snapshot-store';

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
		SnapshotEnvelope.create<Account>(accountId, 10, 'account', { balance: 50 }),
		SnapshotEnvelope.create<Account>(accountId, 20, 'account', { balance: 20 }),
		SnapshotEnvelope.create<Account>(accountId, 30, 'account', { balance: 60 }),
		SnapshotEnvelope.create<Account>(accountId, 40, 'account', { balance: 100 }),
		SnapshotEnvelope.create<Account>(accountId, 50, 'account', { balance: 70 }),
		SnapshotEnvelope.create<Account>(accountId, 60, 'account', { balance: 150 }),
	];

	beforeEach(() => {
		snapshotStore = new InMemorySnapshotStore();
	});

	it('should append snapshots', () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		expect(snapshotStore).toHaveProperty('snapshotCollection', new Map([[snapshotStream.name, snapshots]]));
	});

	it('should retrieve a single snapshot', () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshot = snapshotStore.getSnapshot(snapshotStream, snapshots[3].metadata.sequence);

		expect(resolvedSnapshot).toEqual(snapshots[3]);
	});

	it("should throw when a snapshot isn't found", () => {
		expect(() => snapshotStore.getSnapshot(snapshotStream, 5)).toThrow(
			SnapshotNotFoundException.withVersion(snapshotStream.name, 5),
		);
	});

	it('should retrieve snapshots forward', () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve snapshots backwards', () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, undefined, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 40);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 40));
	});

	it('should retrieve snapshots backwards from a certain version', () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 30, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 30).reverse());
	});

	it('should retrieve the last snapshot', () => {
		snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshot = snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', () => {
		expect(snapshotStore.getLastSnapshot(snapshotStream)).toBeUndefined();
	});
});