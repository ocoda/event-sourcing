import { MongoClient } from 'mongodb';
import {
	AggregateRoot,
	Id,
	ISnapshot,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
} from '../../../../lib';
import { MongoDBSnapshotStore, MongoSnapshotEnvelopeEntity } from '../../../../lib/integration/snapshot-store';

class Account extends AggregateRoot {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

describe(MongoDBSnapshotStore, () => {
	let now = Date.now();
	let client: MongoClient;
	let snapshotStore: MongoDBSnapshotStore;
	let snapshotEnvelopes: SnapshotEnvelope[];

	const accountId = AccountId.generate();
	const snapshotStream = SnapshotStream.for(Account, accountId);

	const snapshots: ISnapshot<Account>[] = [{ balance: 50 }, { balance: 20 }, { balance: 60 }, { balance: 50 }];

	beforeAll(async () => {
		jest.spyOn(global.Date, 'now').mockImplementation(() => now);
		client = await new MongoClient('mongodb://localhost:27017').connect();
		snapshotStore = new MongoDBSnapshotStore(client);

		snapshotEnvelopes = [
			SnapshotEnvelope.create<Account>(accountId, 10, snapshots[0]),
			SnapshotEnvelope.create<Account>(accountId, 20, snapshots[1]),
			SnapshotEnvelope.create<Account>(accountId, 30, snapshots[2]),
			SnapshotEnvelope.create<Account>(accountId, 40, snapshots[3]),
		];
	});

	afterAll(async () => {
		jest.clearAllMocks();
		await Promise.all([
			client
				.db()
				.collection(snapshotStream.subject)
				.deleteMany({}),
			client.db().collection('foo-snapshot').deleteMany({}),
		]);
		await client.close();
	});

	it('should append snapshots', async () => {
		await snapshotStore.appendSnapshot(accountId, 10, snapshotStream, snapshots[0]);
		await snapshotStore.appendSnapshot(accountId, 20, snapshotStream, snapshots[1]);
		await snapshotStore.appendSnapshot(accountId, 30, snapshotStream, snapshots[2]);
		await snapshotStore.appendSnapshot(accountId, 40, snapshotStream, snapshots[3]);

		const result = await client
			.db()
			.collection<MongoSnapshotEnvelopeEntity<Account>>(snapshotStream.subject)
			.find()
			.toArray();
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

	it('should retrieve a single snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getSnapshot(snapshotStream, 20);

		expect(resolvedSnapshot).toEqual(snapshots[1]);
	});

	it("should throw when a snapshot isn't found", async () => {
		await expect(snapshotStore.getSnapshot(snapshotStream, 5)).rejects.toThrow(
			SnapshotNotFoundException.withVersion(snapshotStream.name, 5),
		);
	});

	it('should retrieve snapshots forward', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve snapshots backwards', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, 20);

		expect(resolvedSnapshots).toEqual(snapshots.filter((_, index) => (index + 1) * 10 >= 20));
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, 20, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.filter((_, index) => (index + 1) * 10 >= 20).reverse());
	});

	it('should retrieve the last snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		class Foo extends AggregateRoot {}
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, Id.generate()));

		expect(resolvedSnapshot).toBeUndefined();
	});
});
