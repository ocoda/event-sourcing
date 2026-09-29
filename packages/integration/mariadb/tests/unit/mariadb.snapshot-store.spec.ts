import { randomInt } from 'node:crypto';
import {
	Aggregate,
	AggregateRoot,
	type ISnapshot,
	type ISnapshotCollection,
	SnapshotCollection,
	type SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	SnapshotStream,
	StreamReadingDirection,
	UUID,
} from '@ocoda/event-sourcing';
import { type MariaDBSnapshotEntity, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
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
import type { Pool } from 'mariadb';
import { CATALOG, createSnapshotStore, createTestDatabase, dropTables, poolOf } from '../support/stores.js';

describe(MariaDBSnapshotStore, () => {
	let snapshotStore: MariaDBSnapshotStore;
	const envelopesAccountA = snapshotEnvelopesAccountA;
	const envelopesAccountB = snapshotEnvelopesAccountB;

	let pool: Pool;

	beforeAll(async () => {
		snapshotStore = createSnapshotStore();

		await snapshotStore.connect();
		await snapshotStore.ensureCollection();

		pool = poolOf(snapshotStore);
	});

	afterAll(async () => {
		await dropTables(
			pool,
			[undefined, 'a', 'b', 'c', 'highest'].map((name) => SnapshotCollection.get(name)),
		);
		await snapshotStore.disconnect();
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

		const entities = await pool.query<MariaDBSnapshotEntity<Account>[]>(`
            SELECT * FROM \`${SnapshotCollection.get()}\` ORDER BY version ASC
        `);

		const entitiesAccountA = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === snapshotStreamAccountA.streamId,
		);
		const entitiesAccountB = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === snapshotStreamAccountB.streamId,
		);
		const entitiesCustomer = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === snapshotStreamCustomer.streamId,
		);
		expect(entitiesAccountA).toHaveLength(snapshotsAccountA.length);
		expect(entitiesAccountB).toHaveLength(snapshotsAccountB.length);
		expect(entitiesCustomer).toHaveLength(2);
		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.stream_id).toEqual(snapshotStreamAccountA.streamId);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregate_id).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(entity.registered_on).toBeInstanceOf(Date);
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
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			fromVersion: 30,
		})) {
			resolvedSnapshots.push(...snapshots);
		}
		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(3));
	});

	it("should throw when a snapshot isn't found in a specified stream", async () => {
		const stream = SnapshotStream.for(Account, AccountId.generate());
		await expect(snapshotStore.getSnapshot(stream, 20)).rejects.toThrow(
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
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Foo, { limit: 15 })) {
			firstPageEnvelopes.push(...envelopes);
		}

		expect(firstPageEnvelopes).toHaveLength(15);
		for (const { metadata } of firstPageEnvelopes) {
			fetchedAccountIds.add(metadata.aggregateId);
		}

		const lastPageEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopesForAggregate(Foo, {
			limit: 5,
			aggregateId: firstPageEnvelopes[14].metadata.aggregateId,
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
	describe('schema v2', () => {
		it('creates the table with millisecond times, binary ids and a unique latest flag, and registers it', async () => {
			const [{ 'Create Table': ddl }] = await pool.query<{ 'Create Table': string }[]>(
				`SHOW CREATE TABLE ${pool.escapeId(SnapshotCollection.get())}`,
			);
			expect(ddl).toMatch(/`registered_on` datetime\(3\) NOT NULL/);
			expect(ddl).toMatch(/UNIQUE KEY `ux_latest` \(`aggregate_name`,`latest`\)/);
			expect(ddl).toMatch(/COLLATE=utf8mb4_bin/);
			expect(ddl).not.toMatch(/ON UPDATE/i);
			expect(
				await pool.query(`SELECT kind, schema_version FROM ${CATALOG} WHERE name = ?`, [SnapshotCollection.get()]),
			).toEqual([{ kind: 'snapshots', schema_version: 2 }]);
		});

		it('reads in READ COMMITTED sessions, whatever the isolation level the pool sessions start with', async () => {
			const uncommitted = createSnapshotStore({
				initSql: 'SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED',
				connectionLimit: 1,
			});
			await uncommitted.connect();
			try {
				await expect(poolOf(uncommitted).query('SELECT @@tx_isolation AS isolation')).resolves.toEqual([
					{ isolation: 'READ-COMMITTED' },
				]);
			} finally {
				await uncommitted.disconnect();
			}
		});

		it('reads the snapshot with the highest version as the last one, whatever the latest flag says', async () => {
			await snapshotStore.ensureCollection('highest');
			const stream = SnapshotStream.for(Account, AccountId.generate());
			await snapshotStore.appendSnapshot(stream, 1, snapshotsAccountA[0], 'highest');
			// A higher version without the flag, as a 3.x table can have it
			await pool.query(
				`INSERT INTO ${pool.escapeId(SnapshotCollection.get('highest'))}
				 (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
				 VALUES (?, 2, ?, 'snapshot-2', ?, '2024-01-02 03:04:05.678', ?, NULL)`,
				[stream.streamId, JSON.stringify(snapshotsAccountA[1]), stream.aggregateId, stream.aggregate],
			);

			const last = await snapshotStore.getLastEnvelope(stream, 'highest');
			expect(last?.metadata).toMatchObject({
				version: 2,
				snapshotId: 'snapshot-2',
				registeredOn: new Date('2024-01-02T03:04:05.678Z'),
			});
			await expect(snapshotStore.getLastSnapshot(stream, 'highest')).resolves.toEqual(snapshotsAccountA[1]);
			expect((await snapshotStore.getLastSnapshots([stream], 'highest')).get(stream)).toEqual(snapshotsAccountA[1]);
			expect(
				(await snapshotStore.getManyLastSnapshotEnvelopes([stream], 'highest')).get(stream)?.metadata.version,
			).toBe(2);
			await expect(snapshotStore.getManyLastSnapshotEnvelopes([], 'highest')).resolves.toEqual(new Map());
		});

		it("with ddl: 'none', checks and registers the tables and creates nothing", async () => {
			const database = await createTestDatabase('sddl');
			const auto = createSnapshotStore({ ...database.config });
			const none = createSnapshotStore({ ...database.config, ddl: 'none' });
			await Promise.all([auto.connect(), none.connect()]);
			const logged = vi.spyOn(none['logger'], 'error').mockImplementation(() => undefined);
			try {
				const noCatalog = await none.ensureCollection('tenant').catch((error: unknown) => error);
				expect(noCatalog).toBeInstanceOf(SnapshotStoreCollectionCreationException);
				expect(((noCatalog as Error).cause as Error).message).toMatch(
					/CREATE TABLE IF NOT EXISTS `event_sourcing_collections`/,
				);
				// The exception has no message of its own: the statements to run reach the logs too
				expect(logged).toHaveBeenCalledWith(((noCatalog as Error).cause as Error).message);

				await auto.ensureCollection('other');
				const noTable = await none.ensureCollection('tenant').catch((error: unknown) => error);
				expect(((noTable as Error).cause as Error).message).toMatch(/CREATE TABLE IF NOT EXISTS `tenant-snapshots`/);

				// Created from the remedy by a DBA
				const [, table] = ((noTable as Error).cause as Error).message.split('run:\n')[1].split(';\n');
				await poolOf(auto).query(table);
				await expect(none.ensureCollection('tenant')).resolves.toBe('tenant-snapshots');
				const listed: string[] = [];
				for await (const batch of none.listCollections()) {
					listed.push(...batch);
				}
				expect(listed).toEqual(['other-snapshots', 'tenant-snapshots']);
			} finally {
				logged.mockRestore();
				await Promise.all([auto.disconnect(), none.disconnect()]);
				await database.drop();
			}
		});
	});
});
