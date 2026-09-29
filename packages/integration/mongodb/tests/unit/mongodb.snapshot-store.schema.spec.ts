import { randomBytes } from 'node:crypto';
import {
	type ISnapshotPool,
	SnapshotCollection,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import type { MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { Account, AccountId, mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { Collection, type Db, type MongoClient } from 'mongodb';
import { APPEND_LIMITS } from '../../lib/mongodb.utils.js';
import { createV1SnapshotCollection, v1SnapshotDocument } from '../fixtures/schema-v1.js';
import { drain, expectRejectionOfClass } from '../support/assertions.js';
import { CATALOG, dropCollections, rawCollection } from '../support/catalog.js';
import { createSnapshotStore } from '../support/stores.js';

// Schema v2 of the snapshot collections (ADR 0002 §4): the unique latest flag, the catalog registration, the 3.x
// collections that keep working with a warning, `ddl: 'none'`, and the last snapshot as the highest version.

const uniquePool = (name: string): ISnapshotPool => `mongo-snap-${name}-${randomBytes(4).toString('hex')}`;

/** A URL of the same server with another database, for the specs that need a database without a catalog. */
const withDatabase = (url: string, database: string): string => {
	const parsed = new URL(url);
	parsed.pathname = `/${database}`;
	return parsed.toString();
};

describe.each(mongodbTestTopologies())('MongoDBSnapshotStore schema v2 ($name)', ({ name, url }) => {
	let store: MongoDBSnapshotStore;
	let database: Db;
	const pools: ISnapshotPool[] = [];

	const reservePool = (label: string): ISnapshotPool => {
		const pool = uniquePool(label);
		pools.push(pool);
		return pool;
	};
	const newStream = () => SnapshotStream.for(Account, AccountId.generate());
	const catalog = () => rawCollection(database, CATALOG);

	beforeAll(async () => {
		store = createSnapshotStore({ url });
		await store.connect();
		database = store['database'];
	});

	afterAll(async () => {
		await dropCollections(
			database,
			pools.map((pool) => SnapshotCollection.get(pool)),
		);
		await store.disconnect();
	});

	describe('ensureCollection', () => {
		it('creates the collection with the unique latest flag, and registers it', async () => {
			const pool = reservePool('create');
			const collection = SnapshotCollection.get(pool);

			await expect(store.ensureCollection(pool)).resolves.toBe(collection);
			await expect(store.ensureCollection(pool)).resolves.toBe(collection);

			const indexes = await rawCollection(database, collection).indexes();
			expect(indexes.map(({ name: index, key, unique }) => [index, key, unique])).toEqual([
				['_id_', { _id: 1 }, undefined],
				['streamId_1_version_1', { streamId: 1, version: 1 }, true],
				['latest_unique', { aggregateName: 1, latest: 1 }, true],
			]);
			expect(indexes.find(({ name: index }) => index === 'latest_unique')?.partialFilterExpression).toEqual({
				latest: { $type: 'string' },
			});
			expect(await catalog().findOne({ _id: collection })).toEqual({
				_id: collection,
				kind: 'snapshots',
				schemaVersion: 2,
			});
			expect((await drain(store.listCollections())).includes(collection)).toBe(true);
		});

		it('keeps a 3.x collection working, registered with schema version 1, and warns once', async () => {
			const pool = reservePool('legacy');
			const collection = SnapshotCollection.get(pool);
			const stream = newStream();
			await createV1SnapshotCollection(database, collection);
			await rawCollection(database, collection).insertMany([
				v1SnapshotDocument(stream, 1, false),
				v1SnapshotDocument(stream, 2, true),
			]);
			const warn = vi.spyOn(store['logger'], 'warn');

			await store.ensureCollection(pool);
			await store.ensureCollection(pool);

			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toContain('MongoDBSnapshotStore.migrate(config, { dryRun: true })');
			expect(await catalog().findOne({ _id: collection })).toMatchObject({ kind: 'snapshots', schemaVersion: 1 });

			await store.appendSnapshot(stream, 3, { balance: 3 }, pool);
			const documents = await rawCollection(database, collection)
				.find({}, { sort: { version: 1 } })
				.toArray();
			// 3.x's `latest: null` is not a flag; the replica-set path unsets it along with the old flag
			expect(
				documents.map(({ version, latest }) => [version, typeof latest === 'string' ? latest : 'unflagged']),
			).toEqual([
				[1, 'unflagged'],
				[2, 'unflagged'],
				[3, `latest#${stream.streamId}`],
			]);
			expect((await store.getLastEnvelope(stream, pool))?.metadata.version).toBe(3);
			const latest = await drain(store.getLastEnvelopesForAggregate(Account, { pool }));
			expect(latest.map(({ metadata }) => metadata.version)).toEqual([3]);
		});

		it("with ddl: 'none', registers an existing collection and names the statements that create a missing one", async () => {
			const noDdl = createSnapshotStore({ url, ddl: 'none' });
			await noDdl.connect();
			try {
				const missing = reservePool('ddl-none');
				const error = await expectRejectionOfClass(
					noDdl.ensureCollection(missing),
					SnapshotStoreCollectionCreationException,
					{ collection: SnapshotCollection.get(missing) },
				);
				expect(String((error.cause as Error).message)).toContain(
					`db.createCollection('${SnapshotCollection.get(missing)}')`,
				);
				expect(String((error.cause as Error).message)).toContain("name: 'latest_unique'");
				expect(await database.listCollections({ name: SnapshotCollection.get(missing) }).toArray()).toEqual([]);

				const created = reservePool('ddl-none-created');
				await store.ensureCollection(created);
				await catalog().deleteOne({ _id: SnapshotCollection.get(created) });
				await expect(noDdl.ensureCollection(created)).resolves.toBe(SnapshotCollection.get(created));
				expect(await catalog().findOne({ _id: SnapshotCollection.get(created) })).toMatchObject({ schemaVersion: 2 });
			} finally {
				await noDdl.disconnect();
			}
		});

		it("with ddl: 'none' and no catalog, names the statement that creates the catalog too", async () => {
			const databaseName = `es_mgo_snap_nocatalog_${randomBytes(4).toString('hex')}`;
			const noDdl = createSnapshotStore({ url: withDatabase(url, databaseName), ddl: 'none' });
			await noDdl.connect();
			try {
				const error = await expectRejectionOfClass(noDdl.ensureCollection(), SnapshotStoreCollectionCreationException);
				expect(String((error.cause as Error).message)).toContain(`db.createCollection('${CATALOG}')`);

				// An existing collection, but still no catalog
				await (noDdl['client'] as MongoClient).db(databaseName).createCollection('snapshots');
				const again = await expectRejectionOfClass(noDdl.ensureCollection(), SnapshotStoreCollectionCreationException);
				expect(String((again.cause as Error).message)).toContain(`db.createCollection('${CATALOG}')`);
			} finally {
				await (noDdl['client'] as MongoClient).db(databaseName).dropDatabase();
				await noDdl.disconnect();
			}
		});
	});

	describe('the latest flag', () => {
		it('flags only the last snapshot, and the unique index refuses a second flag', async () => {
			const pool = reservePool('flag');
			const collection = SnapshotCollection.get(pool);
			await store.ensureCollection(pool);
			const stream = newStream();
			for (const version of [1, 2, 3]) {
				await store.appendSnapshot(stream, version, { balance: version }, pool);
			}

			const documents = await rawCollection(database, collection)
				.find({}, { sort: { version: 1 } })
				.toArray();
			expect(documents.map((document) => Object.hasOwn(document, 'latest'))).toEqual([false, false, true]);
			await expect(
				rawCollection(database, collection).insertOne({
					...v1SnapshotDocument(stream, 4, true),
				}),
			).rejects.toMatchObject({ code: 11000 });
		});

		it('reads the snapshot with the highest version as the last one, wherever the flag is', async () => {
			const pool = reservePool('highest');
			const collection = SnapshotCollection.get(pool);
			await createV1SnapshotCollection(database, collection);
			const stream = newStream();
			// 3.x data whose flag sits on a lower version (an interrupted 3.x append)
			await rawCollection(database, collection).insertMany([
				v1SnapshotDocument(stream, 1, true),
				v1SnapshotDocument(stream, 2, false),
			]);
			await store.ensureCollection(pool);

			expect((await store.getLastEnvelope(stream, pool))?.metadata.version).toBe(2);
			expect((await store.getLastSnapshot(stream, pool)) as unknown).toEqual({ balance: 2 });
			const [last] = (await store.getManyLastSnapshotEnvelopes([stream], pool)).values();
			expect(last.metadata.version).toBe(2);
		});

		it('keeps the previous snapshot flagged when the insert of the next one fails', async () => {
			const pool = reservePool('keep-flag');
			const collection = SnapshotCollection.get(pool);
			await store.ensureCollection(pool);
			const stream = newStream();
			await store.appendSnapshot(stream, 1, { balance: 1 }, pool);
			const cause = new Error('insert failed');
			vi.spyOn(Collection.prototype, 'insertOne').mockRejectedValueOnce(cause);

			const error = await expectRejectionOfClass(
				store.appendSnapshot(stream, 2, { balance: 2 }, pool),
				SnapshotStorePersistenceException,
				{ collection },
			);
			expect(error.cause).toBe(cause);

			// A replica set aborts the transaction that unflagged it; a standalone server flags it again
			const documents = await rawCollection(database, collection).find({}).toArray();
			expect(documents.map(({ version, latest }) => [version, latest])).toEqual([[1, `latest#${stream.streamId}`]]);
			expect((await store.getLastEnvelope(stream, pool))?.metadata.version).toBe(1);
			const latest = await drain(store.getLastEnvelopesForAggregate(Account, { pool }));
			expect(latest.map(({ metadata }) => metadata.version)).toEqual([1]);
		});

		describe.runIf(name === 'replica-set')('on a replica set', () => {
			it('retries an append whose transaction conflicted, and gives up once the budget is spent', async () => {
				const pool = reservePool('transient');
				await store.ensureCollection(pool);
				const stream = newStream();
				const transient = () =>
					Object.assign(new Error('write conflict'), { errorLabels: ['TransientTransactionError'] });
				const insertOne = vi.spyOn(Collection.prototype, 'insertOne').mockRejectedValueOnce(transient());

				await expect(store.appendSnapshot(stream, 1, { balance: 1 }, pool)).resolves.toBeDefined();
				expect((await store.getLastEnvelope(stream, pool))?.metadata.version).toBe(1);

				const budget = APPEND_LIMITS.transactionBudgetMs;
				APPEND_LIMITS.transactionBudgetMs = 50;
				try {
					insertOne.mockImplementation(async () => {
						throw transient();
					});
					const error = await expectRejectionOfClass(
						store.appendSnapshot(stream, 2, { balance: 2 }, pool),
						SnapshotStorePersistenceException,
					);
					expect(String((error.cause as Error).message)).toContain('kept racing');
				} finally {
					APPEND_LIMITS.transactionBudgetMs = budget;
				}
				expect((await store.getLastEnvelope(stream, pool))?.metadata.version).toBe(1);
			});
		});
	});

	describe('connecting', () => {
		it('disconnects once, and not at all before it connected', async () => {
			const other = createSnapshotStore({ url });
			await expect(other.disconnect()).resolves.toBeUndefined();
			await expect(other.migrate()).rejects.toThrow('not connected');

			await other.connect();
			const close = vi.spyOn(other['client'] as MongoClient, 'close');
			await other.disconnect();
			await other.disconnect();
			expect(close).toHaveBeenCalledTimes(1);
		});
	});
});
