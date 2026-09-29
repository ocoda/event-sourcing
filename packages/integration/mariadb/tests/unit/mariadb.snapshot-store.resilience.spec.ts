import { randomBytes } from 'node:crypto';
import {
	type ISnapshotPool,
	SnapshotCollection,
	type SnapshotEnvelope,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import { type MariaDBSnapshotEntity, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { Account, AccountId } from '@ocoda/event-sourcing-testing/unit';
import type { Pool, PoolConnection } from 'mariadb';
import type { MockInstance } from 'vitest';
import { createSnapshotStore, poolOf } from '../support/stores.js';

// Pool exhaustion and concurrency scenarios: allow slow tests and setup/teardown hooks.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const uniquePool = (name: string): ISnapshotPool => `mdbfix-${name}-${randomBytes(4).toString('hex')}`;

describe(`${MariaDBSnapshotStore.name} resilience`, () => {
	// A small pool makes leaked connections show up as soon as more iterations than connections were executed.
	const POOL_SIZE = 2;
	let snapshotStore: MariaDBSnapshotStore;
	let pool: Pool;
	const pools: ISnapshotPool[] = [];

	const newPool = async (name: string): Promise<ISnapshotPool> => {
		const snapshotPool = uniquePool(name);
		pools.push(snapshotPool);
		await snapshotStore.ensureCollection(snapshotPool);
		return snapshotPool;
	};

	const newStream = () => SnapshotStream.for(Account, AccountId.generate());

	/** Seeds rows directly, bypassing the store. */
	const seed = async (
		snapshotPool: ISnapshotPool,
		rows: { stream: SnapshotStream; version: number; payload: Record<string, unknown>; latest: boolean }[],
	) => {
		await pool.batch(
			`INSERT INTO ${pool.escapeId(SnapshotCollection.get(snapshotPool))} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			rows.map(({ stream, version, payload, latest }) => [
				stream.streamId,
				version,
				JSON.stringify(payload),
				randomBytes(16).toString('hex'),
				stream.aggregateId,
				new Date(),
				stream.aggregate,
				latest ? `latest#${stream.streamId}` : null,
			]),
		);
	};

	const padding = 'x'.repeat(2000);
	const COUNT = 3000;

	/** Seeds a stream with a result set that is big enough to not fit in the socket buffers. */
	const seedLargeStream = async (snapshotPool: ISnapshotPool) => {
		const stream = newStream();
		await seed(
			snapshotPool,
			Array.from({ length: COUNT }, (_, index) => ({
				stream,
				version: index + 1,
				payload: { balance: index, padding },
				latest: index === COUNT - 1,
			})),
		);
		return stream;
	};

	/** Seeds many streams that each have a latest snapshot. */
	const seedManyLatest = async (snapshotPool: ISnapshotPool) => {
		await seed(
			snapshotPool,
			Array.from({ length: COUNT }, (_, index) => ({
				stream: newStream(),
				version: 1,
				payload: { balance: index, padding },
				latest: true,
			})),
		);
	};

	const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> => {
		const all: T[] = [];
		for await (const batch of generator) {
			all.push(...batch);
		}
		return all;
	};

	beforeAll(async () => {
		snapshotStore = createSnapshotStore({ connectionLimit: POOL_SIZE, acquireTimeout: 3_000 });
		await snapshotStore.connect();

		pool = poolOf(snapshotStore);
	});

	afterAll(async () => {
		await Promise.all(
			pools.map((snapshotPool) =>
				pool.query(`DROP TABLE IF EXISTS ${pool.escapeId(SnapshotCollection.get(snapshotPool))}`),
			),
		);
		await pool.end();
	});

	describe('reading', () => {
		it('should reject instead of returning an empty history when the collection does not exist', async () => {
			const stream = newStream();
			const missingPool = uniquePool('missing');

			await expect(drain(snapshotStore.getSnapshots(stream, { pool: missingPool }))).rejects.toMatchObject({
				errno: 1146,
				code: 'ER_NO_SUCH_TABLE',
			});
			await expect(drain(snapshotStore.getEnvelopes(stream, { pool: missingPool }))).rejects.toMatchObject({
				errno: 1146,
				code: 'ER_NO_SUCH_TABLE',
			});
			await expect(
				drain(snapshotStore.getLastEnvelopesForAggregate(Account, { pool: missingPool })),
			).rejects.toMatchObject({ errno: 1146, code: 'ER_NO_SUCH_TABLE' });

			// The connection of the failed reads is released
			expect(pool.activeConnections()).toBe(0);
		});

		it('should not leak connections when the consumer stops reading early', async () => {
			const snapshotPool = await newPool('early-exit');
			const stream = await seedLargeStream(snapshotPool);
			await seedManyLatest(snapshotPool);

			// More iterations than connections in the pool: a leaked connection would time out the acquisition.
			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				for await (const batch of snapshotStore.getSnapshots(stream, { pool: snapshotPool, batch: 1 })) {
					expect(batch).toHaveLength(1);
					break;
				}
				expect(pool.activeConnections()).toBe(0);
			}

			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				for await (const batch of snapshotStore.getEnvelopes(stream, { pool: snapshotPool, batch: 1 })) {
					expect(batch).toHaveLength(1);
					break;
				}
				expect(pool.activeConnections()).toBe(0);
			}

			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				for await (const batch of snapshotStore.getLastEnvelopesForAggregate(Account, {
					pool: snapshotPool,
					batch: 1,
				})) {
					expect(batch).toHaveLength(1);
					break;
				}
				expect(pool.activeConnections()).toBe(0);
			}

			// and the pool still reads the full history afterwards
			const envelopes = await drain(snapshotStore.getEnvelopes(stream, { pool: snapshotPool, batch: 500 }));
			expect(envelopes).toHaveLength(COUNT);
		});

		it('should not leak connections when the consumer throws while reading', async () => {
			const snapshotPool = await newPool('consumer-throws');
			const stream = await seedLargeStream(snapshotPool);

			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				await expect(async () => {
					for await (const _ of snapshotStore.getEnvelopes(stream, { pool: snapshotPool, batch: 1 })) {
						throw new Error('consumer failure');
					}
				}).rejects.toThrow('consumer failure');
				expect(pool.activeConnections()).toBe(0);
			}
		});
	});

	describe('appending', () => {
		it('should throw a persistence exception and release the connection when the collection does not exist', async () => {
			await expect(snapshotStore.appendSnapshot(newStream(), 1, { balance: 0 }, uniquePool('missing'))).rejects.toThrow(
				SnapshotStorePersistenceException,
			);
			expect(pool.activeConnections()).toBe(0);
		});

		it('should throw a persistence exception and release the connection when the collection name cannot be escaped', async () => {
			await expect(snapshotStore.appendSnapshot(newStream(), 1, { balance: 0 }, 'nul\u0000pool')).rejects.toThrow(
				SnapshotStorePersistenceException,
			);
			expect(pool.activeConnections()).toBe(0);
		});

		it('should not let a failing rollback hide the original error', async () => {
			const getConnection = pool.getConnection.bind(pool);
			const rollbacks: MockInstance[] = [];
			const getConnectionSpy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
				const connection: PoolConnection = await getConnection();
				rollbacks.push(vi.spyOn(connection, 'rollback').mockRejectedValue(new Error('rollback failure')));
				return connection;
			});

			try {
				await expect(
					snapshotStore.appendSnapshot(newStream(), 1, { balance: 0 }, uniquePool('missing')),
				).rejects.toThrow(SnapshotStorePersistenceException);
				expect(rollbacks).toHaveLength(1);
				expect(rollbacks[0]).toHaveBeenCalled();
			} finally {
				getConnectionSpy.mockRestore();
				for (const rollback of rollbacks) {
					rollback.mockRestore();
				}
			}
			expect(pool.activeConnections()).toBe(0);
		});

		describe('concurrent writers', () => {
			const WRITERS = 8;

			const newConcurrentStore = async () => {
				const store = createSnapshotStore({ connectionLimit: WRITERS + 2 });
				await store.connect();
				return store;
			};

			const append = (
				store: MariaDBSnapshotStore,
				stream: SnapshotStream,
				version: number,
				snapshotPool: ISnapshotPool,
			) =>
				Promise.allSettled(
					Array.from({ length: WRITERS }, (_, writer) =>
						store.appendSnapshot(stream, version, { balance: writer }, snapshotPool),
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
					expect(reason).toMatchObject({
						streamId: stream.streamId,
						aggregateId: stream.aggregateId,
						pool: snapshotPool,
						version,
						latestVersion: version,
					});
				}

				const entities = await pool.query<MariaDBSnapshotEntity<Account>[]>(
					`SELECT * FROM ${pool.escapeId(SnapshotCollection.get(snapshotPool))} WHERE stream_id = ? ORDER BY version ASC`,
					[stream.streamId],
				);
				expect(entities.map(({ version }) => version)).toEqual(expectedVersions);
				// exactly one snapshot is the latest, and it is the one that was appended last
				expect(entities.filter(({ latest }) => latest).map(({ version }) => version)).toEqual([version]);
			};

			it('should let exactly one writer win and report a version conflict to the others', async () => {
				const concurrentStore = await newConcurrentStore();

				try {
					const snapshotPool = await newPool('concurrent');
					for (let round = 0; round < 5; round++) {
						const stream = newStream();

						// first snapshot of the stream
						await expectExactlyOneWinner(
							await append(concurrentStore, stream, 1, snapshotPool),
							stream,
							1,
							[1],
							snapshotPool,
						);
						// next snapshot of the stream: also replaces the latest marker
						await expectExactlyOneWinner(
							await append(concurrentStore, stream, 2, snapshotPool),
							stream,
							2,
							[1, 2],
							snapshotPool,
						);
					}
				} finally {
					await concurrentStore.disconnect();
				}
			});

			it('should report a version conflict when racing appends to a new stream all passed the version check', async () => {
				const concurrentStore = await newConcurrentStore();

				const concurrentPool: Pool = poolOf(concurrentStore);
				const getConnection = concurrentPool.getConnection.bind(concurrentPool);

				// Hold every writer right after its version check until all of them have passed it. A new stream has no
				// flagged snapshot to lock, so none of them waits there, and the unique keys of the table have to decide.
				let versionChecks = 0;
				let releaseWriters: () => void;
				const allChecked = new Promise<void>((resolve) => {
					releaseWriters = resolve;
				});
				const getConnectionSpy = vi.spyOn(concurrentPool, 'getConnection').mockImplementation(async () => {
					const connection: PoolConnection = await getConnection();
					const query = connection.query.bind(connection);
					vi.spyOn(connection, 'query').mockImplementation(async (sql: unknown, values?: unknown) => {
						const result = await query(sql as string, values);
						if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
							versionChecks++;
							if (versionChecks === WRITERS) {
								releaseWriters();
							}
							if (versionChecks <= WRITERS) {
								await allChecked;
							}
						}
						return result;
					});
					return connection;
				});

				try {
					const snapshotPool = await newPool('concurrent-check');
					const stream = newStream();

					await expectExactlyOneWinner(
						await append(concurrentStore, stream, 1, snapshotPool),
						stream,
						1,
						[1],
						snapshotPool,
					);
					expect(versionChecks).toBe(WRITERS);
				} finally {
					getConnectionSpy.mockRestore();
					await concurrentStore.disconnect();
				}
			});

			it('should run an append again when InnoDB picks it as the victim of a deadlock, up to 10 times', async () => {
				const snapshotPool = await newPool('deadlock');
				const getConnection = pool.getConnection.bind(pool);
				let deadlocks = 0;
				let failInserts = 2;
				const getConnectionSpy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
					const connection: PoolConnection = await getConnection();
					const query = connection.query.bind(connection);
					vi.spyOn(connection, 'query').mockImplementation(async (sql: unknown, values?: unknown) => {
						if (typeof sql === 'string' && sql.startsWith('INSERT INTO') && deadlocks < failInserts) {
							deadlocks++;
							throw Object.assign(new Error('Deadlock found when trying to get lock'), {
								errno: 1213,
								code: 'ER_LOCK_DEADLOCK',
							});
						}
						return query(sql as string, values);
					});
					return connection;
				});

				try {
					const stream = newStream();
					await expect(snapshotStore.appendSnapshot(stream, 1, { balance: 1 }, snapshotPool)).resolves.toMatchObject({
						metadata: { version: 1 },
					});
					expect(deadlocks).toBe(2);
					await expect(snapshotStore.getLastEnvelope(stream, snapshotPool)).resolves.toMatchObject({
						metadata: { version: 1 },
					});

					deadlocks = 0;
					failInserts = Number.POSITIVE_INFINITY;
					const error = await snapshotStore
						.appendSnapshot(stream, 2, { balance: 2 }, snapshotPool)
						.catch((caught: unknown) => caught);
					expect(error).toBeInstanceOf(SnapshotStorePersistenceException);
					expect((error as Error).cause).toMatchObject({ errno: 1213 });
					expect(deadlocks).toBe(10);
					// Every attempt was rolled back: the snapshot at version 1 is still the latest
					await expect(snapshotStore.getLastEnvelope(stream, snapshotPool)).resolves.toMatchObject({
						metadata: { version: 1 },
					});
				} finally {
					getConnectionSpy.mockRestore();
				}
				expect(pool.activeConnections()).toBe(0);
			});

			it('should keep one latest snapshot per stream while the streams of an aggregate race each other', async () => {
				// Few connections for many appends: the appends to different streams deadlock on the unique latest index,
				// and InnoDB's victims run again
				const racingStore = createSnapshotStore({ connectionLimit: 10 });
				await racingStore.connect();
				try {
					const snapshotPool = await newPool('streams');
					const failures: string[] = [];
					for (let round = 0; round < 12; round++) {
						await Promise.all(
							Array.from({ length: WRITERS }, async (_, index) => {
								const stream = newStream();
								const seeded = (round + index) % 2;
								if (seeded) {
									await racingStore.appendSnapshot(stream, 1, { balance: 1 }, snapshotPool);
								}
								const versions = [3, 7, 2, 8, 5, 4, 6, 9].map((version) => version + seeded);
								const results = await Promise.allSettled(
									versions.map((version) =>
										racingStore.appendSnapshot(stream, version, { balance: version }, snapshotPool),
									),
								);
								for (const result of results) {
									if (
										result.status === 'rejected' &&
										!(result.reason instanceof SnapshotStoreVersionConflictException)
									) {
										failures.push(String(result.reason?.cause ?? result.reason));
									}
								}
								const appended = versions.filter((_, writer) => results[writer].status === 'fulfilled');
								const last = await racingStore.getLastEnvelope(stream, snapshotPool);
								expect(last?.metadata.version).toBe(Math.max(...appended));
								const flagged = await pool.query<{ version: number }[]>(
									`SELECT version FROM ${pool.escapeId(SnapshotCollection.get(snapshotPool))} WHERE stream_id = ? AND latest IS NOT NULL`,
									[stream.streamId],
								);
								expect(flagged.map(({ version }) => version)).toEqual([Math.max(...appended)]);
							}),
						);
					}
					expect(failures).toEqual([]);
				} finally {
					await racingStore.disconnect();
				}
			});
		});
	});

	describe('table identifiers', () => {
		it('should quote the collection name in every statement', async () => {
			// A quote in a pool (e.g. a tenant identifier) must never end up in the statement unescaped.
			const snapshotPool = uniquePool("ten`ant's");
			pools.push(snapshotPool);
			const stream = newStream();

			await expect(snapshotStore.ensureCollection(snapshotPool)).resolves.toBe(SnapshotCollection.get(snapshotPool));
			await snapshotStore.appendSnapshot(stream, 1, { balance: 10 }, snapshotPool);
			await snapshotStore.appendSnapshot(stream, 2, { balance: 20 }, snapshotPool);

			await expect(snapshotStore.getSnapshot(stream, 1, snapshotPool)).resolves.toEqual({ balance: 10 });
			await expect(snapshotStore.getEnvelope(stream, 2, snapshotPool)).resolves.toMatchObject({
				payload: { balance: 20 },
			});
			await expect(snapshotStore.getLastSnapshot(stream, snapshotPool)).resolves.toEqual({ balance: 20 });
			await expect(snapshotStore.getLastEnvelope(stream, snapshotPool)).resolves.toMatchObject({
				metadata: { version: 2 },
			});
			await expect(snapshotStore.getLastSnapshots([stream], snapshotPool)).resolves.toEqual(
				new Map([[stream, { balance: 20 }]]),
			);
			expect(
				(await snapshotStore.getManyLastSnapshotEnvelopes([stream], snapshotPool)).get(stream)?.metadata.version,
			).toBe(2);

			expect(await drain(snapshotStore.getSnapshots(stream, { pool: snapshotPool }))).toEqual([
				{ balance: 10 },
				{ balance: 20 },
			]);
			expect(await drain(snapshotStore.getEnvelopes(stream, { pool: snapshotPool }))).toHaveLength(2);
			expect(await drain(snapshotStore.getLastEnvelopesForAggregate(Account, { pool: snapshotPool }))).toHaveLength(1);
			expect(await drain(snapshotStore.listCollections())).toContain(SnapshotCollection.get(snapshotPool));
		});
	});
});
