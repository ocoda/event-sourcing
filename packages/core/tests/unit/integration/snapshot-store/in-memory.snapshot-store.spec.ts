import { randomInt } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
	Aggregate,
	AggregateRoot,
	type ISnapshot,
	type ISnapshotCollection,
	type SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	SnapshotStream,
	StreamReadingDirection,
	UUID,
} from '@ocoda/event-sourcing';
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
import { InMemorySnapshotStore } from '@ocoda/event-sourcing/integration/snapshot-store';

describe(InMemorySnapshotStore, () => {
	let snapshotStore: InMemorySnapshotStore;
	const envelopesAccountA = snapshotEnvelopesAccountA;
	const envelopesAccountB = snapshotEnvelopesAccountB;

	beforeAll(async () => {
		snapshotStore = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });

		await snapshotStore.connect();
		await snapshotStore.ensureCollection();
	});

	afterAll(() => snapshotStore.disconnect());

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

		const entities = snapshotStore.collections.get('snapshots') || [];
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
		await expect(
			snapshotStore.appendSnapshot(snapshotStreamAccountA, beforeLastVersion, lastSnapshotEnvelope),
		).rejects.toThrow(
			new SnapshotStoreVersionConflictException({
				stream: snapshotStreamAccountA,
				version: beforeLastVersion,
				latestVersion: lastVersion,
			}),
		);
		await expect(
			snapshotStore.appendSnapshot(snapshotStreamAccountA, lastVersion, lastSnapshotEnvelope),
		).rejects.toThrow(
			new SnapshotStoreVersionConflictException({
				stream: snapshotStreamAccountA,
				version: lastVersion,
				latestVersion: lastVersion,
			}),
		);
	});

	it("should throw when a snapshot envelope can't be appended", async () => {
		await expect(() =>
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
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { fromVersion: 30 })) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(3));
	});

	it("should reject when a snapshot isn't found in a specified stream", async () => {
		const stream = SnapshotStream.for(Account, AccountId.generate());
		await expect(snapshotStore.getSnapshot(stream, 20)).rejects.toThrow(
			new SnapshotNotFoundException({ streamId: stream.streamId, version: 20 }),
		);
		await expect(snapshotStore.getEnvelope(stream, 20)).rejects.toThrow(
			new SnapshotNotFoundException({ streamId: stream.streamId, version: 20 }),
		);
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
		const resolvedSnapshots = await snapshotStore.getLastSnapshots([snapshotStreamAccountA, snapshotStreamAccountB]);

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

	it('should retrieve the last snapshot-envelope', async () => {
		const lastEnvelope = envelopesAccountA[envelopesAccountA.length - 1];
		const snapshotEnvelope = await snapshotStore.getLastEnvelope(snapshotStreamAccountA);

		if (!snapshotEnvelope) {
			throw new Error('Snapshot envelope not found');
		}

		const { metadata, payload } = snapshotEnvelope;

		expect(payload).toEqual(lastEnvelope.payload);
		expect(metadata.aggregateId).toEqual(lastEnvelope.metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(lastEnvelope.metadata.version);
	});

	it('should filter the last snapshot-envelopes by streamId', async () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}

		class FooId extends UUID {}

		const fooIds = Array.from({ length: 20 }).map(() => FooId.generate());
		const latestVersions = new Map<string, number>();
		for (const id of fooIds) {
			// multiple snapshots per stream, only the latest one should be returned
			const latestVersion = randomInt(2, 10) * 10;
			await snapshotStore.appendSnapshot(SnapshotStream.for(Foo, id), 10, { balance: randomInt(1000) });
			await snapshotStore.appendSnapshot(SnapshotStream.for(Foo, id), latestVersion, { balance: randomInt(1000) });
			latestVersions.set(id.value, latestVersion);
		}

		// the envelopes are ordered by their stream (descending)
		const expectedIds = fooIds.map(({ value }) => value).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

		const firstPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Foo, { limit: 15 })) {
			firstPageEnvelopes.push(...envelopes);
		}

		expect(firstPageEnvelopes).toHaveLength(15);

		const lastPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Foo, {
			limit: 15,
			aggregateId: firstPageEnvelopes[14].metadata.aggregateId,
		})) {
			lastPageEnvelopes.push(...envelopes);
		}

		// only the 5 remaining Foo aggregates come after the cursor
		expect(lastPageEnvelopes).toHaveLength(5);

		const firstPageIds = firstPageEnvelopes.map(({ metadata }) => metadata.aggregateId);
		const lastPageIds = lastPageEnvelopes.map(({ metadata }) => metadata.aggregateId);

		// the pages are disjoint, in a consistent order and together contain every Foo aggregate exactly once
		expect(firstPageIds.filter((id) => lastPageIds.includes(id))).toEqual([]);
		expect([...firstPageIds, ...lastPageIds]).toEqual(expectedIds);
		expect(new Set([...firstPageIds, ...lastPageIds]).size).toBe(fooIds.length);

		// every envelope is the latest snapshot of its stream
		for (const { metadata } of [...firstPageEnvelopes, ...lastPageEnvelopes]) {
			expect(metadata.version).toBe(latestVersions.get(metadata.aggregateId));
		}

		// there is nothing after the last page
		const emptyPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Foo, {
			aggregateId: lastPageIds[lastPageIds.length - 1],
		})) {
			emptyPageEnvelopes.push(...envelopes);
		}
		expect(emptyPageEnvelopes).toEqual([]);
	});

	it('should retrieve the last snapshot-envelopes for an aggregate', async () => {
		let resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Account)) {
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

		if (!resolvedAccountAEnvelope || !resolvedAccountBEnvelope) {
			throw new Error('Snapshot envelope not found');
		}

		expect(resolvedAccountAEnvelope.payload).toEqual(envelopeAccountA.payload);
		expect(resolvedAccountAEnvelope.metadata.aggregateId).toEqual(envelopeAccountA.metadata.aggregateId);
		expect(resolvedAccountAEnvelope.metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedAccountAEnvelope.metadata.version).toEqual(envelopeAccountA.metadata.version);

		expect(resolvedAccountBEnvelope.payload).toEqual(envelopeAccountB.payload);
		expect(resolvedAccountBEnvelope.metadata.aggregateId).toEqual(envelopeAccountB.metadata.aggregateId);
		expect(resolvedAccountBEnvelope.metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedAccountBEnvelope.metadata.version).toEqual(envelopeAccountB.metadata.version);
	});

	it('should list collections', async () => {
		await Promise.all([
			snapshotStore.ensureCollection('a'),
			snapshotStore.ensureCollection('b'),
			snapshotStore.ensureCollection('c'),
		]);

		const resolvedCollections: ISnapshotCollection[] = [];
		for await (const collections of snapshotStore.listCollections()) {
			resolvedCollections.push(...collections);
		}

		expect(resolvedCollections.includes('a-snapshots')).toBe(true);
		expect(resolvedCollections.includes('b-snapshots')).toBe(true);
		expect(resolvedCollections.includes('c-snapshots')).toBe(true);
	});
});

describe(`${InMemorySnapshotStore.name} lifecycle`, () => {
	let snapshotStore: InMemorySnapshotStore;

	beforeEach(async () => {
		vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		snapshotStore = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });
		await snapshotStore.connect();
		await snapshotStore.ensureCollection();
	});

	afterEach(async () => {
		await snapshotStore.disconnect();
		vi.restoreAllMocks();
	});

	it('does not throw when disconnecting before connecting', async () => {
		const unconnectedStore = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });

		await expect(unconnectedStore.disconnect()).resolves.toBeUndefined();
	});

	it('does not wipe existing snapshots when ensuring an existing collection', async () => {
		await snapshotStore.ensureCollection('tenant-1');
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 10, snapshotsAccountA[0], 'tenant-1');
		await snapshotStore.appendSnapshot(snapshotStreamAccountA, 10, snapshotsAccountA[0]);

		await expect(snapshotStore.ensureCollection('tenant-1')).resolves.toBe('tenant-1-snapshots');
		await expect(snapshotStore.ensureCollection()).resolves.toBe('snapshots');

		expect(snapshotStore.collections.get('tenant-1-snapshots')).toHaveLength(1);
		expect(snapshotStore.collections.get('snapshots')).toHaveLength(1);
		await expect(snapshotStore.getLastSnapshot(snapshotStreamAccountA, 'tenant-1')).resolves.toEqual(
			snapshotsAccountA[0],
		);
	});
});

describe(`${InMemorySnapshotStore.name} v4 contract`, () => {
	@Aggregate({ streamName: 'contract' })
	class Contract extends AggregateRoot {}

	let snapshotStore: InMemorySnapshotStore;

	beforeEach(async () => {
		vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		snapshotStore = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });
		await snapshotStore.connect();
		await snapshotStore.ensureCollection();
	});

	afterEach(async () => {
		await snapshotStore.disconnect();
		vi.restoreAllMocks();
	});

	it('answers every call with a promise, and fails by rejecting', async () => {
		const stream = SnapshotStream.for(Contract, UUID.generate());
		const calls = [
			snapshotStore.getSnapshot(stream, 1),
			snapshotStore.getEnvelope(stream, 1),
			snapshotStore.getLastSnapshot(stream),
			snapshotStore.getLastEnvelope(stream),
			snapshotStore.getLastSnapshots([stream]),
			snapshotStore.getManyLastSnapshotEnvelopes([stream]),
			snapshotStore.appendSnapshot(stream, 1, { n: 1 }, 'unknown-pool'),
		];

		for (const call of calls) {
			expect(call).toBeInstanceOf(Promise);
		}
		const results = await Promise.allSettled(calls);
		expect(results.map(({ status }) => status)).toEqual([
			'rejected',
			'rejected',
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'rejected',
		]);
	});

	it('reads the snapshot with the highest version as the last one, whichever snapshot carries the latest key', async () => {
		const stream = SnapshotStream.for(Contract, UUID.generate());
		await snapshotStore.appendSnapshot(stream, 1, { n: 1 });
		await snapshotStore.appendSnapshot(stream, 2, { n: 2 });

		// Move the latest key to the older snapshot, as a store that lost track of its flag would have it
		const entities = (snapshotStore.collections.get('snapshots') ?? []).filter(
			({ streamId }) => streamId === stream.streamId,
		);
		entities[0].latest = entities[1].latest;
		entities[1].latest = null;

		await expect(snapshotStore.getLastSnapshot(stream)).resolves.toEqual({ n: 2 });
		expect((await snapshotStore.getLastEnvelope(stream))?.metadata.version).toBe(2);
		expect((await snapshotStore.getLastSnapshots([stream])).get(stream)).toEqual({ n: 2 });
		expect((await snapshotStore.getManyLastSnapshotEnvelopes([stream])).get(stream)?.metadata.version).toBe(2);
		await expect(snapshotStore.appendSnapshot(stream, 2, { n: 3 })).rejects.toMatchObject({
			version: 2,
			latestVersion: 2,
		});

		// The next append moves the latest key back to the snapshot with the highest version
		await snapshotStore.appendSnapshot(stream, 3, { n: 3 });
		expect(entities.map(({ latest }) => latest)).toEqual([null, null]);
		expect((await snapshotStore.getLastEnvelope(stream))?.metadata.version).toBe(3);
	});

	it('orders the latest snapshots of an aggregate case-sensitively, in binary order', async () => {
		const suffix = UUID.generate().value.slice(1);
		const ids = ['a', 'B', 'A', 'b'].map((prefix) => `${prefix}${suffix}`);
		for (const id of ids) {
			await snapshotStore.appendSnapshot(SnapshotStream.for(Contract, UUID.from(id)), 1, { id });
		}

		const read = async (aggregateId?: string) => {
			const aggregateIds: string[] = [];
			for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Contract, { aggregateId })) {
				aggregateIds.push(...envelopes.map(({ metadata }) => metadata.aggregateId));
			}
			return aggregateIds.map((id) => id[0]);
		};

		expect(await read()).toEqual(['b', 'a', 'B', 'A']);
		// The cursor is exclusive, and 'B' < 'a' < 'b'
		expect(await read(`a${suffix}`)).toEqual(['B', 'A']);
		expect(await read(`B${suffix}`)).toEqual(['A']);
		expect(await read(`b${suffix}`)).toEqual(['a', 'B', 'A']);
	});
});
