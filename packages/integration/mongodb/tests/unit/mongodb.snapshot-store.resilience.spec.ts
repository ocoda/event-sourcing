import { randomBytes } from 'node:crypto';
import {
	type ISnapshotPool,
	SnapshotCollection,
	type SnapshotEnvelope,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import { type MongoDBSnapshotEntity, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { Account, AccountId } from '@ocoda/event-sourcing-testing/unit';
import { AbstractCursor, Collection, type Db, type MongoClient } from 'mongodb';

jest.setTimeout(30_000);

type Config = ConstructorParameters<typeof MongoDBSnapshotStore>[0];

const config = () => ({ url: 'mongodb://localhost:27017' }) as unknown as Config;

const uniquePool = (name: string): ISnapshotPool => `mongofix-${name}-${randomBytes(4).toString('hex')}`;

describe(`${MongoDBSnapshotStore.name} resilience`, () => {
	let snapshotStore: MongoDBSnapshotStore;
	let client: MongoClient;
	let database: Db;
	const pools: ISnapshotPool[] = [];

	const newStore = async () => {
		const store = new MongoDBSnapshotStore(config());
		await store.connect();
		return store;
	};

	const newPool = async (name: string, store: MongoDBSnapshotStore = snapshotStore): Promise<ISnapshotPool> => {
		const snapshotPool = uniquePool(name);
		pools.push(snapshotPool);
		await store.ensureCollection(snapshotPool);
		return snapshotPool;
	};

	const newStream = () => SnapshotStream.for(Account, AccountId.generate());

	/** The number of cursors that are open on the server for a collection. */
	const openCursors = async (snapshotPool: ISnapshotPool): Promise<number> => {
		const cursors = await client
			.db('admin')
			.aggregate([
				{ $currentOp: { allUsers: true, idleCursors: true } },
				{ $match: { type: 'idleCursor', ns: `${database.databaseName}.${SnapshotCollection.get(snapshotPool)}` } },
			])
			.toArray();
		return cursors.length;
	};

	const document = (stream: SnapshotStream, version: number, latest: boolean) => ({
		_id: randomBytes(16).toString('hex'),
		streamId: stream.streamId,
		payload: { balance: version },
		aggregateName: stream.aggregate,
		latest: latest ? `latest#${stream.streamId}` : undefined,
		snapshotId: randomBytes(16).toString('hex'),
		aggregateId: stream.aggregateId,
		registeredOn: new Date(),
		version,
	});

	/** Seeds more snapshots than fit in the first batch of a server cursor (101). */
	const seed = async (snapshotPool: ISnapshotPool, count = 300) => {
		const stream = newStream();
		await database.collection<MongoDBSnapshotEntity<Account>>(SnapshotCollection.get(snapshotPool)).insertMany([
			...Array.from({ length: count }, (_, index) => document(stream, index + 1, index === count - 1)),
			// snapshots of other streams, that are the latest of their stream
			...Array.from({ length: count }, (_, index) => document(newStream(), 1, true)),
		]);
		return stream;
	};

	beforeAll(async () => {
		snapshotStore = await newStore();

		client = snapshotStore['client'];
		database = snapshotStore['database'];
	});

	afterAll(async () => {
		await Promise.all(
			pools.map((snapshotPool) =>
				database
					.collection(SnapshotCollection.get(snapshotPool))
					.drop()
					.catch(() => undefined),
			),
		);
		await snapshotStore.disconnect();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('reading', () => {
		it('should close the cursor when the consumer stops reading early', async () => {
			const snapshotPool = await newPool('early-exit');
			const stream = await seed(snapshotPool);

			for await (const batch of snapshotStore.getSnapshots(stream, { pool: snapshotPool, batch: 1 })) {
				expect(batch).toHaveLength(1);
				// the cursor is open while the consumer is reading...
				expect(await openCursors(snapshotPool)).toBe(1);
				break;
			}
			// ...and closed as soon as it stops
			expect(await openCursors(snapshotPool)).toBe(0);

			for await (const batch of snapshotStore.getEnvelopes(stream, { pool: snapshotPool, batch: 1 })) {
				expect(batch).toHaveLength(1);
				expect(await openCursors(snapshotPool)).toBe(1);
				break;
			}
			expect(await openCursors(snapshotPool)).toBe(0);

			for await (const batch of snapshotStore.getLastEnvelopesForAggregate(Account, { pool: snapshotPool, batch: 1 })) {
				expect(batch).toHaveLength(1);
				expect(await openCursors(snapshotPool)).toBe(1);
				break;
			}
			expect(await openCursors(snapshotPool)).toBe(0);
		});

		it('should close the cursor of the collections listing when the consumer stops reading early', async () => {
			await newPool('listing-a');
			await newPool('listing-b');
			const close = jest.spyOn(AbstractCursor.prototype, 'close');

			for await (const batch of snapshotStore.listCollections({ batch: 1 })) {
				expect(batch).toHaveLength(1);
				break;
			}

			expect(close).toHaveBeenCalled();
		});

		it('should close the cursor when the consumer throws while reading', async () => {
			const snapshotPool = await newPool('consumer-throws');
			const stream = await seed(snapshotPool);

			await expect(async () => {
				for await (const _ of snapshotStore.getEnvelopes(stream, { pool: snapshotPool, batch: 1 })) {
					expect(await openCursors(snapshotPool)).toBe(1);
					throw new Error('consumer failure');
				}
			}).rejects.toThrow('consumer failure');

			expect(await openCursors(snapshotPool)).toBe(0);
		});

		it('should not reuse the yielded batches', async () => {
			const snapshotPool = await newPool('batches');
			const stream = await seed(snapshotPool, 250);

			const batches: unknown[][] = [];
			for await (const batch of snapshotStore.getSnapshots(stream, { pool: snapshotPool, batch: 100 })) {
				batches.push(batch);
			}

			expect(batches.map(({ length }) => length)).toEqual([100, 100, 50]);
		});
	});

	describe('appending', () => {
		describe('to known collections', () => {
			it('should not look up the collection again on every append', async () => {
				const snapshotPool = await newPool('known');
				const listCollections = jest.spyOn(database, 'listCollections');

				const stream = newStream();
				await snapshotStore.appendSnapshot(stream, 1, { balance: 1 }, snapshotPool);
				await snapshotStore.appendSnapshot(stream, 2, { balance: 2 }, snapshotPool);
				await snapshotStore.appendSnapshot(stream, 3, { balance: 3 }, snapshotPool);

				expect(listCollections).not.toHaveBeenCalled();
			});

			it('should look up a collection that was created elsewhere only once', async () => {
				const snapshotPool = await newPool('elsewhere');
				const otherStore = await newStore();

				try {
					const listCollections = jest.spyOn(otherStore['database'], 'listCollections');

					const stream = newStream();
					await otherStore.appendSnapshot(stream, 1, { balance: 1 }, snapshotPool);
					await otherStore.appendSnapshot(stream, 2, { balance: 2 }, snapshotPool);
					await otherStore.appendSnapshot(stream, 3, { balance: 3 }, snapshotPool);

					expect(listCollections).toHaveBeenCalledTimes(1);
				} finally {
					await otherStore.disconnect();
				}
			});
		});

		describe('to unknown collections', () => {
			it('should keep rejecting them and check the server each time', async () => {
				const snapshotPool = uniquePool('unknown');
				pools.push(snapshotPool);
				const listCollections = jest.spyOn(database, 'listCollections');

				await expect(snapshotStore.appendSnapshot(newStream(), 1, { balance: 1 }, snapshotPool)).rejects.toThrow(
					SnapshotStorePersistenceException,
				);
				await expect(snapshotStore.appendSnapshot(newStream(), 1, { balance: 1 }, snapshotPool)).rejects.toThrow(
					SnapshotStorePersistenceException,
				);
				expect(listCollections).toHaveBeenCalledTimes(2);

				// once the collection exists, it is picked up
				const otherStore = await newStore();
				try {
					await otherStore.ensureCollection(snapshotPool);
				} finally {
					await otherStore.disconnect();
				}
				await expect(snapshotStore.appendSnapshot(newStream(), 1, { balance: 1 }, snapshotPool)).resolves.toBeDefined();
			});
		});

		describe('concurrent writers', () => {
			const WRITERS = 8;

			const settle = (stream: SnapshotStream, version: number, snapshotPool: ISnapshotPool) =>
				Promise.allSettled(
					Array.from({ length: WRITERS }, (_, writer) =>
						snapshotStore.appendSnapshot(stream, version, { balance: writer }, snapshotPool),
					),
				);

			const expectExactlyOneWinner = async (
				results: PromiseSettledResult<SnapshotEnvelope<Account>>[],
				stream: SnapshotStream,
				version: number,
				expectedVersions: number[],
				snapshotPool: ISnapshotPool,
			) => {
				const fulfilled = results.filter(({ status }) => status === 'fulfilled');
				const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(WRITERS - 1);
				for (const { reason } of rejected) {
					expect(reason).toBeInstanceOf(SnapshotStoreVersionConflictException);
					expect(reason.message).toBe(new SnapshotStoreVersionConflictException(stream, version, version).message);
				}

				const entities = await database
					.collection<MongoDBSnapshotEntity<Account>>(SnapshotCollection.get(snapshotPool))
					.find({ streamId: stream.streamId })
					.sort({ version: 1 })
					.toArray();
				expect(entities.map(({ version }) => version)).toEqual(expectedVersions);
				// exactly one snapshot is the latest, and it is the one that was appended last
				expect(entities.filter(({ latest }) => latest).map(({ version }) => version)).toEqual([version]);
			};

			it('should let exactly one writer win and report a version conflict to the others', async () => {
				const snapshotPool = await newPool('concurrent');
				for (let round = 0; round < 5; round++) {
					const stream = newStream();

					// first snapshot of the stream
					await expectExactlyOneWinner(await settle(stream, 1, snapshotPool), stream, 1, [1], snapshotPool);
					// next snapshot of the stream: also replaces the latest marker
					await expectExactlyOneWinner(await settle(stream, 2, snapshotPool), stream, 2, [1, 2], snapshotPool);
				}
			});

			it('should report a version conflict when the race is lost after the version check passed', async () => {
				const snapshotPool = await newPool('concurrent-check');
				const stream = newStream();
				await snapshotStore.appendSnapshot(stream, 1, { balance: 0 }, snapshotPool);

				// Hold every writer right before its insert, so after its version check, until all of them got there.
				// None of them can then be stopped by the check and the unique index has to decide.
				let waiting = 0;
				let releaseWriters: () => void;
				const allChecked = new Promise<void>((resolve) => {
					releaseWriters = resolve;
				});
				const insertOne = Collection.prototype.insertOne;
				const insertOneSpy = jest.spyOn(Collection.prototype, 'insertOne').mockImplementation(async function (
					this: Collection,
					...args: Parameters<Collection['insertOne']>
				) {
					if (++waiting === WRITERS) {
						releaseWriters();
					}
					await allChecked;
					return insertOne.apply(this, args);
				});

				await expectExactlyOneWinner(await settle(stream, 2, snapshotPool), stream, 2, [1, 2], snapshotPool);
				expect(insertOneSpy).toHaveBeenCalledTimes(WRITERS);
			});
		});
	});
});
