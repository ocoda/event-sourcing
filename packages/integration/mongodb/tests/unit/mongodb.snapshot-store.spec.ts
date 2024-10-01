import { randomInt } from 'node:crypto';
import {
	Aggregate,
	AggregateRoot,
	type ISnapshot,
	SnapshotCollection,
	type SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	SnapshotStream,
	StreamReadingDirection,
	UUID,
} from '@ocoda/event-sourcing';
import { type MongoDBSnapshotEntity, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import {
	Account,
	AccountId,
	customerSnapshot,
	snapshotEnvelopesAccountA,
	snapshotEnvelopesAccountB,
	snapshotStreamAccountA,
	snapshotStreamAccountB,
	snapshotStreamCustomer,
	snapshotsAccountA,
	snapshotsAccountB,
} from '@ocoda/event-sourcing-testing/unit';
import {} from '@ocoda/event-sourcing/integration/event-store';
import type { MongoClient } from 'mongodb';

describe(MongoDBSnapshotStore, () => {
	let snapshotStore: MongoDBSnapshotStore;
	const envelopesAccountA = snapshotEnvelopesAccountA;
	const envelopesAccountB = snapshotEnvelopesAccountB;

	let client: MongoClient;

	beforeAll(async () => {
		snapshotStore = new MongoDBSnapshotStore({ driver: undefined, url: 'mongodb://localhost:27017' });

		await snapshotStore.connect();
		await snapshotStore.ensureCollection();

		// biome-ignore lint/complexity/useLiteralKeys: Needed to check the internal workings of the event store
		client = snapshotStore['client'];
	});

	afterAll(async () => {
		await client.db().dropCollection(SnapshotCollection.get());
		await client.close();
	});

	it('should append snapshot envelopes', async () => {
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 1, snapshotsAccountA[0]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 1, snapshotsAccountB[0]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 10, snapshotsAccountA[1]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 10, snapshotsAccountB[1]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 20, snapshotsAccountA[2]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 20, snapshotsAccountB[2]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 30, snapshotsAccountA[3]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountB, 30, snapshotsAccountB[3]);
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 40, snapshotsAccountA[4]);
		await snapshotStore.appendSnapshot(snapshotStreamCustomer, 1, customerSnapshot);
		await snapshotStore.appendSnapshot(snapshotStreamCustomer, 10, customerSnapshot);
		const entities = await client
			.db()
			.collection<MongoDBSnapshotEntity<Account>>(SnapshotCollection.get())
			.find()
			.sort({ version: 1 })
			.toArray();
		const entitiesAccountA = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamAccountA.streamId,
		);
		const entitiesAccountB = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamAccountB.streamId,
		);
		const entitiesCustomer = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamCustomer.streamId,
		);
		expect(entitiesAccountA).toHaveLength(snapshotsAccountA.length);
		expect(entitiesAccountB).toHaveLength(snapshotsAccountB.length);
		expect(entitiesCustomer).toHaveLength(2);
		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.streamId).toEqual(snapshotStreamAccountA.streamId);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(entity.registeredOn).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);

			if (index === entitiesAccountA.length - 1) {
				expect(entity.latest).toEqual(`latest#${snapshotStreamAccountA.streamId}`);
			} else {
				expect(entity.latest).toBeNull();
			}
		}
	});

	it('should throw when trying to append a snapshot to a stream that has a version lower or equal to the latest snapshot for that stream', async () => {
		const lastSnapshotEnvelope = snapshotEnvelopesAccountA[snapshotEnvelopesAccountA.length - 1];
		const lastVersion = lastSnapshotEnvelope.metadata.version;
		const beforeLastVersion = lastVersion - 10;
		expect(
			snapshotStore.appendSnapshot(snapshotStreamAccountA, beforeLastVersion, lastSnapshotEnvelope),
		).rejects.toThrow(
			new SnapshotStoreVersionConflictException(snapshotStreamAccountA, beforeLastVersion, lastVersion),
		);
		expect(snapshotStore.appendSnapshot(snapshotStreamAccountA, lastVersion, lastSnapshotEnvelope)).rejects.toThrow(
			new SnapshotStoreVersionConflictException(snapshotStreamAccountA, lastVersion, lastVersion),
		);
	});

	it("should throw when a snapshot envelope can't be appended", async () => {
		expect(() =>
			snapshotStore.appendSnapshot(snapshotStreamAccountA, 1, snapshotsAccountA[0], 'not-a-pool'),
		).rejects.toThrow(SnapshotStorePersistenceException);
	});

	it('should retrieve a single snapshot from a specified stream', async () => {
		const resolvedSnapshot = await snapshotStore.getSnapshot(
			snapshotStreamAccountA,
			envelopesAccountA[1].metadata.version,
		);
		expect(resolvedSnapshot).toEqual(snapshotsAccountA[1]);
	});

	it('should retrieve snapshots by stream', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA)) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA);
	});

	it('should filter snapshots by stream and version', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			fromVersion: 30,
		})) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(3));
	});

	it("should throw when a snapshot isn't found in a specified stream", () => {
		const stream = SnapshotStream.for(Account, AccountId.generate());
		expect(snapshotStore.getSnapshot(stream, 20)).rejects.toThrow(new SnapshotNotFoundException(stream.streamId, 20));
	});

	it('should retrieve snapshots backwards', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice().reverse());
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			fromVersion: envelopesAccountA[1].metadata.version,
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(
			snapshotsAccountA.filter((_, index) => (index + 1) * 10 >= envelopesAccountA[2].metadata.version).reverse(),
		);
	});

	it('should limit the returned snapshots', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { limit: 2 })) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(0, 2));
	});

	it('should batch the returned snapshots', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { limit: 2 })) {
			expect(snapshots.length).toBe(2);
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(0, 2));
	});

	it('should retrieve the last snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStreamAccountA);
		expect(resolvedSnapshot).toEqual(snapshotsAccountA[snapshotsAccountA.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, UUID.generate()));
		expect(resolvedSnapshot).toBeUndefined();
	});

	it('should retrieve multiple last snapshots', async () => {
		const resolvedSnapshots = await snapshotStore.getManyLastSnapshots([
			snapshotStreamAccountA,
			snapshotStreamAccountB,
		]);

		expect(resolvedSnapshots.size).toBe(2);
		expect(resolvedSnapshots.get(snapshotStreamAccountA)).toEqual(snapshotsAccountA[snapshotsAccountA.length - 1]);
		expect(resolvedSnapshots.get(snapshotStreamAccountB)).toEqual(snapshotsAccountB[snapshotsAccountB.length - 1]);
	});

	it('should retrieve snapshot-envelopes', async () => {
		const resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getEnvelopes(snapshotStreamAccountA)) {
			resolvedEnvelopes.push(...envelopes);
		}
		expect(resolvedEnvelopes).toHaveLength(envelopesAccountA.length);
		for (const [index, envelope] of resolvedEnvelopes.entries()) {
			expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopesAccountA[index].metadata.version);
		}
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

	it('should retrieve the last snapshot-envelopes for an aggregate', async () => {
		let resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastAggregateEnvelopes('account')) {
			resolvedEnvelopes.push(...envelopes);
		}

		expect(resolvedEnvelopes).toHaveLength(2);

		const [envelopeAccountB, envelopeAccountA] = [
			envelopesAccountB[envelopesAccountB.length - 1],
			envelopesAccountA[envelopesAccountA.length - 1],
		];

		resolvedEnvelopes = resolvedEnvelopes.sort((a, b) => (a.metadata.version > b.metadata.version ? 1 : -1));

		expect(resolvedEnvelopes[0].payload).toEqual(envelopeAccountB.payload);
		expect(resolvedEnvelopes[0].metadata.aggregateId).toEqual(envelopeAccountB.metadata.aggregateId);
		expect(resolvedEnvelopes[0].metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedEnvelopes[0].metadata.version).toEqual(envelopeAccountB.metadata.version);

		expect(resolvedEnvelopes[1].payload).toEqual(envelopeAccountA.payload);
		expect(resolvedEnvelopes[1].metadata.aggregateId).toEqual(envelopeAccountA.metadata.aggregateId);
		expect(resolvedEnvelopes[1].metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedEnvelopes[1].metadata.version).toEqual(envelopeAccountA.metadata.version);
	});

	it('should filter the last snapshot-envelopes by streamId', async () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}

		class FooId extends UUID {}

		const fooIds = Array.from({ length: 20 })
			.map(() => FooId.generate())
			.sort();
		for await (const id of fooIds) {
			await snapshotStore.appendSnapshot(SnapshotStream.for(Foo, id), randomInt(1, 10) * 10, {
				balance: randomInt(1000),
			});
		}

		const fetchedAccountIds: Set<string> = new Set();
		const firstPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastAggregateEnvelopes('foo', { limit: 15 })) {
			firstPageEnvelopes.push(...envelopes);
		}

		expect(firstPageEnvelopes).toHaveLength(15);
		for (const { metadata } of firstPageEnvelopes) {
			fetchedAccountIds.add(metadata.aggregateId);
		}

		const lastPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastAggregateEnvelopes('foo', {
			limit: 5,
			fromId: firstPageEnvelopes[14].metadata.aggregateId,
		})) {
			lastPageEnvelopes.push(...envelopes);
		}

		expect(lastPageEnvelopes).toHaveLength(5);
		for (const { metadata } of lastPageEnvelopes) {
			fetchedAccountIds.add(metadata.aggregateId);
		}

		expect(fooIds).toHaveLength(20);
	});

	it('should retrieve multiple last snapshot-envelopes for given streams', async () => {
		const resolvedSnapshots = await snapshotStore.getManyLastSnapshotEnvelopes([
			snapshotStreamAccountA,
			snapshotStreamAccountB,
		]);

		expect(resolvedSnapshots.size).toBe(2);

		const [envelopeAccountA, envelopeAccountB] = [
			envelopesAccountA[envelopesAccountA.length - 1],
			envelopesAccountB[envelopesAccountB.length - 1],
		];

		const resolvedAccountAEnvelope = resolvedSnapshots.get(snapshotStreamAccountA);
		const resolvedAccountBEnvelope = resolvedSnapshots.get(snapshotStreamAccountB);

		expect(resolvedAccountAEnvelope.payload).toEqual(envelopeAccountA.payload);
		expect(resolvedAccountAEnvelope.metadata.aggregateId).toEqual(envelopeAccountA.metadata.aggregateId);
		expect(resolvedAccountAEnvelope.metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedAccountAEnvelope.metadata.version).toEqual(envelopeAccountA.metadata.version);

		expect(resolvedAccountBEnvelope.payload).toEqual(envelopeAccountB.payload);
		expect(resolvedAccountBEnvelope.metadata.aggregateId).toEqual(envelopeAccountB.metadata.aggregateId);
		expect(resolvedAccountBEnvelope.metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedAccountBEnvelope.metadata.version).toEqual(envelopeAccountB.metadata.version);
	});
});
