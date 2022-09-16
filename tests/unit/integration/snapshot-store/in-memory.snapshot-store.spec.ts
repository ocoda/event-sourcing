import {
	AggregateRoot,
	Id,
	ISnapshot,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
} from '../../../../lib';
import { InMemorySnapshotStore } from '../../../../lib/integration/snapshot-store';

class Account extends AggregateRoot {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

describe(InMemorySnapshotStore, () => {
	let now = Date.now();
	const accountId = AccountId.generate();
	const snapshotStream = SnapshotStream.for(Account, accountId);

	let snapshotStore: InMemorySnapshotStore;
	let snapshotEnvelopes: SnapshotEnvelope[];

	const snapshots: ISnapshot<Account>[] = [{ balance: 50 }, { balance: 20 }, { balance: 60 }, { balance: 50 }];

	beforeAll(() => {
		jest.spyOn(global.Date, 'now').mockImplementation(() => now);
		snapshotStore = new InMemorySnapshotStore();

		snapshotEnvelopes = [
			SnapshotEnvelope.create<Account>(accountId, 10, snapshots[0]),
			SnapshotEnvelope.create<Account>(accountId, 20, snapshots[1]),
			SnapshotEnvelope.create<Account>(accountId, 30, snapshots[2]),
			SnapshotEnvelope.create<Account>(accountId, 40, snapshots[3]),
		];
	});

	afterAll(() => {
		jest.clearAllMocks();
		snapshotStore['snapshotCollection'].clear();
	});

	it('should append snapshots', () => {
		snapshotStore.appendSnapshot(accountId, 10, snapshotStream, snapshots[0]);
		snapshotStore.appendSnapshot(accountId, 20, snapshotStream, snapshots[1]);
		snapshotStore.appendSnapshot(accountId, 30, snapshotStream, snapshots[2]);
		snapshotStore.appendSnapshot(accountId, 40, snapshotStream, snapshots[3]);

		const result = snapshotStore['snapshotCollection'].get(snapshotStream.subject);

		expect(result).toHaveLength(4);

		const [hit1, hit2, hit3, hit4] = result;

		expect(hit1.stream).toEqual(snapshotStream.name);
		expect(hit1.metadata).toEqual(snapshotEnvelopes[0].metadata);
		expect(hit1.payload).toEqual(snapshotEnvelopes[0].payload);

		expect(hit2.stream).toEqual(snapshotStream.name);
		expect(hit2.metadata).toEqual(snapshotEnvelopes[1].metadata);
		expect(hit2.payload).toEqual(snapshotEnvelopes[1].payload);

		expect(hit3.stream).toEqual(snapshotStream.name);
		expect(hit3.metadata).toEqual(snapshotEnvelopes[2].metadata);
		expect(hit3.payload).toEqual(snapshotEnvelopes[2].payload);

		expect(hit4.stream).toEqual(snapshotStream.name);
		expect(hit4.metadata).toEqual(snapshotEnvelopes[3].metadata);
		expect(hit4.payload).toEqual(snapshotEnvelopes[3].payload);
	});

	it('should retrieve a single snapshot', () => {
		const resolvedSnapshot = snapshotStore.getSnapshot(snapshotStream, 20);

		expect(resolvedSnapshot).toEqual(snapshots[1]);
	});

	it("should throw when a snapshot isn't found", () => {
		expect(() => snapshotStore.getSnapshot(snapshotStream, 5)).toThrow(
			SnapshotNotFoundException.withVersion(snapshotStream.name, 5),
		);
	});

	it('should retrieve snapshots forward', () => {
		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve snapshots backwards', () => {
		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, undefined, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', () => {
		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 20);

		expect(resolvedSnapshots).toEqual(snapshots.filter((_, index) => (index + 1) * 10 >= 20));
	});

	it('should retrieve snapshots backwards from a certain version', () => {
		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, 20, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.filter((_, index) => (index + 1) * 10 >= 20).reverse());
	});

	it('should retrieve the last snapshot', () => {
		const resolvedSnapshot = snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', () => {
		class Foo extends AggregateRoot {}
		const resolvedSnapshot = snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, Id.generate()));

		expect(resolvedSnapshot).toBeUndefined();
	});
});
