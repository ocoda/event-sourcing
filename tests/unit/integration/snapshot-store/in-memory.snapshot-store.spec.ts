import {
	Aggregate,
	AggregateRoot,
	Id,
	ISnapshot,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
} from '../../../../lib';
import { InMemorySnapshotStore } from '../../../../lib/integration/snapshot-store';

class AccountId extends Id {}

@Aggregate({ streamName: 'account' })
class Account extends AggregateRoot {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}

describe(InMemorySnapshotStore, () => {
	const accountId = AccountId.generate();
	const snapshotStream = SnapshotStream.for(Account, accountId);

	let snapshotStore: InMemorySnapshotStore;
	let envelopes: SnapshotEnvelope[];

	const snapshots: ISnapshot<Account>[] = [{ balance: 50 }, { balance: 20 }, { balance: 60 }, { balance: 50 }];

	const seedSnapshots = () => {
		snapshotStore.appendSnapshot(snapshotStream, 10, snapshots[0]);
		snapshotStore.appendSnapshot(snapshotStream, 20, snapshots[1]);
		snapshotStore.appendSnapshot(snapshotStream, 30, snapshots[2]);
		snapshotStore.appendSnapshot(snapshotStream, 40, snapshots[3]);
	};

	beforeAll(() => {
		envelopes = [
			SnapshotEnvelope.create<Account>(snapshots[0], { aggregateId: accountId.value, version: 10 }),
			SnapshotEnvelope.create<Account>(snapshots[1], { aggregateId: accountId.value, version: 20 }),
			SnapshotEnvelope.create<Account>(snapshots[2], { aggregateId: accountId.value, version: 30 }),
			SnapshotEnvelope.create<Account>(snapshots[3], { aggregateId: accountId.value, version: 40 }),
		];
	});

	beforeEach(() => {
		snapshotStore = new InMemorySnapshotStore();
		snapshotStore.setup();
	});

	it('should append snapshot envelopes', () => {
		seedSnapshots();

		const entities = [...snapshotStore['collections'].get(snapshotStream.collection)];

		expect(entities).toHaveLength(snapshots.length);

		entities.forEach((entity, index) => {
			expect(entity.streamId).toEqual(snapshotStream.streamId);
			expect(entity.payload).toEqual(envelopes[index].payload);
			expect(entity.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(entity.metadata.registeredOn).toBeInstanceOf(Date);
			expect(entity.metadata.version).toEqual(envelopes[index].metadata.version);
		});
	});

	it('should retrieve snapshots', () => {
		seedSnapshots();

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve a single snapshot', () => {
		seedSnapshots();

		const resolvedSnapshot = snapshotStore.getSnapshot(snapshotStream, envelopes[1].metadata.version);

		expect(resolvedSnapshot).toEqual(snapshots[1]);
	});

	it("should throw when a snapshot isn't found", () => {
		expect(() => snapshotStore.getSnapshot(snapshotStream, 5)).toThrow(
			new SnapshotNotFoundException(snapshotStream.streamId, 5),
		);
	});

	it('should retrieve snapshots backwards', () => {
		seedSnapshots();

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, undefined, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', () => {
		seedSnapshots();

		const resolvedSnapshots = snapshotStore.getSnapshots(snapshotStream, envelopes[1].metadata.version);

		expect(resolvedSnapshots).toEqual(
			snapshots.filter((_, index) => (index + 1) * 10 >= envelopes[1].metadata.version),
		);
	});

	it('should retrieve snapshots backwards from a certain version', () => {
		seedSnapshots();

		const resolvedSnapshots = snapshotStore.getSnapshots(
			snapshotStream,
			envelopes[1].metadata.version,
			StreamReadingDirection.BACKWARD,
		);

		expect(resolvedSnapshots).toEqual(
			snapshots.filter((_, index) => (index + 1) * 10 >= envelopes[1].metadata.version).reverse(),
		);
	});

	it('should retrieve the last snapshot', () => {
		seedSnapshots();

		const resolvedSnapshot = snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}

		const resolvedSnapshot = snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, Id.generate()));

		expect(resolvedSnapshot).toBeUndefined();
	});

	it('should retrieve snapshot-envelopes', async () => {
		seedSnapshots();

		const resolvedEnvelopes = snapshotStore.getEnvelopes(snapshotStream);

		expect(resolvedEnvelopes).toHaveLength(envelopes.length);

		resolvedEnvelopes.forEach((envelope, index) => {
			expect(envelope.payload).toEqual(envelopes[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopes[index].metadata.version);
		});
	});

	it('should retrieve a single snapshot-envelope', async () => {
		seedSnapshots();

		const { metadata, payload } = snapshotStore.getEnvelope(snapshotStream, envelopes[3].metadata.version);

		expect(payload).toEqual(envelopes[3].payload);
		expect(metadata.aggregateId).toEqual(envelopes[3].metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopes[3].metadata.version);
	});
});
