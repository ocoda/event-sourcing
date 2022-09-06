import { InMemorySnapshotStore } from './in-memory.snapshot-store';
import { Aggregate, Id, SnapshotStream, SnapshotEnvelope } from '../../models';
import { StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { MongoDBSnapshotStore } from './mongodb.snapshot-store';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { MongoDBEventStore } from '../event-store';

class Account extends Aggregate {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

describe(MongoDBSnapshotStore, () => {
	let mongod: MongoMemoryServer;
	let client: MongoClient;
	let snapshotStore: MongoDBSnapshotStore;

	const accountId = AccountId.generate();
	const snapshotStream = SnapshotStream.for(Account, accountId);

	const snapshots = [
		SnapshotEnvelope.new<Account>(accountId, 10, 'account', { balance: 50 }),
		SnapshotEnvelope.new<Account>(accountId, 20, 'account', { balance: 20 }),
		SnapshotEnvelope.new<Account>(accountId, 30, 'account', { balance: 60 }),
		SnapshotEnvelope.new<Account>(accountId, 40, 'account', { balance: 100 }),
		SnapshotEnvelope.new<Account>(accountId, 50, 'account', { balance: 70 }),
		SnapshotEnvelope.new<Account>(accountId, 60, 'account', { balance: 150 }),
	];

	beforeAll(async () => {
		mongod = await MongoMemoryServer.create();
		client = new MongoClient(mongod.getUri());
		snapshotStore = new MongoDBSnapshotStore(client.db());
	});

	afterEach(
		async () =>
			client
				.db()
				.collection(`${snapshotStream.subject}-snapshot`)
				.deleteMany({}),
	);

	afterAll(async () => {
		await client.close();
		await mongod.stop();
	});

	it('should append snapshots', async () => {
		await snapshotStore.appendSnapshots(snapshotStream, snapshots);
		const storedSnapshots = await client
			.db()
			.collection(`${snapshotStream.subject}-snapshot`)
			.find()
			.toArray();

		expect(storedSnapshots.map(({ _id }) => _id)).toEqual(snapshots.map(({ snapshotId }) => snapshotId));
	});

	it('should retrieve a single snapshot', async () => {
		await snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshot = await snapshotStore.getSnapshot(snapshotStream, snapshots[3].metadata.sequence);

		expect(resolvedSnapshot).toEqual(snapshots[3]);
	});

	it("should throw when a snapshot isn't found", async () => {
		await expect(snapshotStore.getSnapshot(snapshotStream, 5)).rejects.toThrow(
			SnapshotNotFoundException.withVersion(snapshotStream.name, 5),
		);
	});

	it('should retrieve snapshots forward', async () => {
		await snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve snapshots backwards', async () => {
		await snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', async () => {
		await snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, 40);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 40));
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		await snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, 30, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.filter(({ metadata }) => metadata.sequence >= 30).reverse());
	});

	it('should retrieve the last snapshot', async () => {
		await snapshotStore.appendSnapshots(snapshotStream, snapshots);

		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toBeUndefined();
	});
});
