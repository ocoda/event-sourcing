import { MongoClient } from 'mongodb';
import {
	Aggregate,
	AggregateRoot,
	Id,
	ISnapshot,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
} from '../../../../lib';
import { MongoDBSnapshotStore, MongoSnapshotEntity } from '../../../../lib/integration/snapshot-store';

class AccountId extends Id {}

@Aggregate({ streamName: 'account' })
class Account extends AggregateRoot {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}

describe(MongoDBSnapshotStore, () => {
	let client: MongoClient;
	let snapshotStore: MongoDBSnapshotStore;
	let envelopesAccountA: SnapshotEnvelope[];
	let envelopesAccountB: SnapshotEnvelope[];

	const snapshots: ISnapshot<Account>[] = [{ balance: 50 }, { balance: 20 }, { balance: 60 }, { balance: 50 }];

	const idAccountA = AccountId.generate();
	const idAccountB = AccountId.generate();
	const snapshotStreamAccountA = SnapshotStream.for(Account, idAccountA);
	const snapshotStreamAccountB = SnapshotStream.for(Account, idAccountB);

	beforeAll(async () => {
		client = new MongoClient('mongodb://localhost:27017');
		snapshotStore = new MongoDBSnapshotStore(client.db());
		await snapshotStore.setup();

		envelopesAccountA = [
			SnapshotEnvelope.create<Account>(snapshots[0], { aggregateId: idAccountA.value, version: 10 }),
			SnapshotEnvelope.create<Account>(snapshots[1], { aggregateId: idAccountA.value, version: 20 }),
			SnapshotEnvelope.create<Account>(snapshots[2], { aggregateId: idAccountA.value, version: 30 }),
			SnapshotEnvelope.create<Account>(snapshots[3], { aggregateId: idAccountA.value, version: 40 }),
		];
		envelopesAccountB = [
			SnapshotEnvelope.create<Account>(snapshots[0], { aggregateId: idAccountB.value, version: 10 }),
			SnapshotEnvelope.create<Account>(snapshots[1], { aggregateId: idAccountB.value, version: 20 }),
			SnapshotEnvelope.create<Account>(snapshots[2], { aggregateId: idAccountB.value, version: 30 }),
			SnapshotEnvelope.create<Account>(snapshots[3], { aggregateId: idAccountB.value, version: 40 }),
		];
	});

	afterAll(async () => {
		await client.db().dropCollection(SnapshotCollection.get());
		await client.close();
	});

	it('should append snapshot envelopes', async () => {
		await Promise.all([
			snapshotStore.appendSnapshot(snapshotStreamAccountA, 10, snapshots[0]),
			snapshotStore.appendSnapshot(snapshotStreamAccountB, 10, snapshots[0]),
			snapshotStore.appendSnapshot(snapshotStreamAccountA, 20, snapshots[1]),
			snapshotStore.appendSnapshot(snapshotStreamAccountB, 20, snapshots[1]),
			snapshotStore.appendSnapshot(snapshotStreamAccountA, 30, snapshots[2]),
			snapshotStore.appendSnapshot(snapshotStreamAccountB, 30, snapshots[2]),
			snapshotStore.appendSnapshot(snapshotStreamAccountA, 40, snapshots[3]),
			snapshotStore.appendSnapshot(snapshotStreamAccountB, 40, snapshots[3]),
		]);

		const entities = await client
			.db()
			.collection<MongoSnapshotEntity<Account>>(SnapshotCollection.get())
			.find()
			.sort({ version: 1 })
			.toArray();

		const entitiesAccountA = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamAccountA.streamId,
		);
		const entitiesAccountB = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamAccountB.streamId,
		);

		expect(entities).toHaveLength(snapshots.length * 2);
		expect(entitiesAccountA).toHaveLength(snapshots.length);
		expect(entitiesAccountB).toHaveLength(snapshots.length);

		entitiesAccountA.forEach((entity, index) => {
			expect(entity.streamId).toEqual(snapshotStreamAccountA.streamId);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(entity.registeredOn).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
		});

		entitiesAccountB.forEach((entity, index) => {
			expect(entity.streamId).toEqual(snapshotStreamAccountB.streamId);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(entity.registeredOn).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountB[index].metadata.version);
		});
	});

	it('should retrieve a single snapshot from a specified stream', async () => {
		const resolvedSnapshot = await snapshotStore.getSnapshot(
			snapshotStreamAccountA,
			envelopesAccountA[1].metadata.version,
		);

		expect(resolvedSnapshot).toEqual(snapshots[1]);
	});

	it('should retrieve snapshots by stream', async () => {
		const resolvedSnapshots = [];
		for await (const snapshots of snapshotStore.getSnapshots({ snapshotStream: snapshotStreamAccountA })) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should filter snapshots by stream and version', async () => {
		const resolvedSnapshots = [];
		for await (const snapshots of snapshotStore.getSnapshots({
			snapshotStream: snapshotStreamAccountA,
			fromVersion: 30,
		})) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshots.slice(2));
	});

	it("should throw when a snapshot isn't found in a specified stream", () => {
		const stream = SnapshotStream.for(Account, AccountId.generate());
		expect(snapshotStore.getSnapshot(stream, 20)).rejects.toThrow(new SnapshotNotFoundException(stream.streamId, 20));
	});

	it('should retrieve snapshots backwards', async () => {
		const resolvedSnapshots = [];
		for await (const snapshots of snapshotStore.getSnapshots({
			snapshotStream: snapshotStreamAccountA,
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		const resolvedSnapshots = [];
		for await (const snapshots of snapshotStore.getSnapshots({
			snapshotStream: snapshotStreamAccountA,
			fromVersion: envelopesAccountA[1].metadata.version,
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(
			snapshots.filter((_, index) => (index + 1) * 10 >= envelopesAccountA[1].metadata.version).reverse(),
		);
	});

	it('should limit the returned snapshots', async () => {
		const resolvedSnapshots = [];
		for await (const snapshots of snapshotStore.getSnapshots({ snapshotStream: snapshotStreamAccountA, limit: 2 })) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshots.slice(0, 2));
	});

	it('should batch the returned snapshots', async () => {
		const resolvedSnapshots = [];
		for await (const snapshots of snapshotStore.getSnapshots({ limit: 2 })) {
			expect(snapshots.length).toBe(2);
			resolvedSnapshots.push(...resolvedSnapshots);
		}

		expect(resolvedSnapshots).toEqual(resolvedSnapshots);
	});

	it('should retrieve the last snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStreamAccountA);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}

		const resolvedSnapshot = await snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, Id.generate()));

		expect(resolvedSnapshot).toBeUndefined();
	});

	it('should retrieve snapshot-envelopes', async () => {
		const resolvedEnvelopes = [];
		for await (const envelopes of snapshotStore.getEnvelopes({
			snapshotStream: snapshotStreamAccountA,
		})) {
			resolvedEnvelopes.push(...envelopes);
		}

		expect(resolvedEnvelopes).toHaveLength(envelopesAccountA.length);

		resolvedEnvelopes.forEach((envelope, index) => {
			expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopesAccountA[index].metadata.version);
		});
	});

	it('should retrieve a single snapshot-envelope', async () => {
		const { metadata, payload } = await snapshotStore.getEnvelope(
			snapshotStreamAccountA,
			envelopesAccountA[3].metadata.version,
		);

		expect(payload).toEqual(envelopesAccountA[3].payload);
		expect(metadata.aggregateId).toEqual(envelopesAccountA[3].metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopesAccountA[3].metadata.version);
	});

	it('should retrieve the last snapshot-envelope', async () => {
		const lastEnvelope = envelopesAccountA[envelopesAccountA.length - 1];
		const { metadata, payload } = await snapshotStore.getLastEnvelope(snapshotStreamAccountA);

		expect(payload).toEqual(lastEnvelope.payload);
		expect(metadata.aggregateId).toEqual(lastEnvelope.metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(lastEnvelope.metadata.version);
	});
});
