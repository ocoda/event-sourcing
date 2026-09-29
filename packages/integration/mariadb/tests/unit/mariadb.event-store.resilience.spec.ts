import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	type EventEnvelope,
	EventId,
	EventStorePersistenceException,
	EventSourcingErrorCode,
	EventStoreVersionConflictException,
	EventStream,
	type IEventPool,
	UnregisteredEventException,
} from '@ocoda/event-sourcing';
import { type MariaDBEventEntity, MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
import {
	Account,
	AccountId,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
} from '@ocoda/event-sourcing-testing/unit';
import type { Pool, PoolConnection } from 'mariadb';
import type { MockInstance } from 'vitest';

// Pool exhaustion and concurrency scenarios: allow slow tests and setup/teardown hooks.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type Config = ConstructorParameters<typeof MariaDBEventStore>[1];

const config = (overrides: Record<string, unknown> = {}) =>
	({
		driver: undefined,
		host: '127.0.0.1',
		port: 3306,
		user: 'mariadb',
		password: 'mariadb',
		database: 'mariadb',
		...overrides,
	}) as unknown as Config;

const uniquePool = (name: string): IEventPool => `mdbfix-${name}-${randomBytes(4).toString('hex')}`;

describe(`${MariaDBEventStore.name} resilience`, () => {
	const eventMap = getEventMap();
	const events = getEvents();

	// A small pool makes leaked connections show up as soon as more iterations than connections were executed.
	const POOL_SIZE = 2;
	let eventStore: MariaDBEventStore;
	let pool: Pool;
	const pools: IEventPool[] = [];

	const newPool = async (name: string): Promise<IEventPool> => {
		const eventPool = uniquePool(name);
		pools.push(eventPool);
		await eventStore.ensureCollection(eventPool);
		return eventPool;
	};

	const newStream = () => EventStream.for(Account, AccountId.generate());

	/** Seeds rows directly, bypassing the store. */
	const seed = async (
		eventPool: IEventPool,
		stream: EventStream,
		rows: { version: number; event: string; payload: Record<string, unknown> }[],
	) => {
		await pool.batch(
			`INSERT INTO ${pool.escapeId(EventCollection.get(eventPool))} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			rows.map(({ version, event, payload }) => {
				const eventId = EventId.generate();
				return [
					stream.streamId,
					version,
					event,
					JSON.stringify(payload),
					eventId.yearMonth,
					eventId.value,
					stream.aggregateId,
					new Date(),
					null,
					null,
				];
			}),
		);
	};

	/** Seeds a stream with a result set that is big enough to not fit in the socket buffers. */
	const seedLargeStream = async (eventPool: IEventPool, count = 3000) => {
		const stream = newStream();
		const padding = 'x'.repeat(2000);
		await seed(
			eventPool,
			stream,
			Array.from({ length: count }, (_, index) => ({
				version: index + 1,
				event: 'account-credited',
				payload: { amount: index, padding },
			})),
		);
		return stream;
	};

	beforeAll(async () => {
		eventStore = new MariaDBEventStore(eventMap, config({ connectionLimit: POOL_SIZE, acquireTimeout: 3_000 }));
		eventStore.publish = vi.fn(async () => Promise.resolve());
		await eventStore.connect();

		pool = eventStore['pool'];
	});

	afterAll(async () => {
		await Promise.all(
			pools.map((eventPool) => pool.query(`DROP TABLE IF EXISTS ${pool.escapeId(EventCollection.get(eventPool))}`)),
		);
		await pool.end();
	});

	describe('reading', () => {
		it('should reject instead of returning an empty history when the collection does not exist', async () => {
			const stream = newStream();
			const missingPool = uniquePool('missing');

			await expect(async () => {
				for await (const _ of eventStore.getEvents(stream, { pool: missingPool })) {
				}
			}).rejects.toMatchObject({ errno: 1146, code: 'ER_NO_SUCH_TABLE' });

			await expect(async () => {
				for await (const _ of eventStore.getEnvelopes(stream, { pool: missingPool })) {
				}
			}).rejects.toMatchObject({ errno: 1146, code: 'ER_NO_SUCH_TABLE' });

			await expect(async () => {
				for await (const _ of eventStore.getAllEnvelopes({ since: { year: 2021, month: 1 }, pool: missingPool })) {
				}
			}).rejects.toMatchObject({ errno: 1146, code: 'ER_NO_SUCH_TABLE' });

			// The connection of the failed reads is released
			expect(pool.activeConnections()).toBe(0);
		});

		it('should reject when an event of the stream is not registered', async () => {
			const eventPool = await newPool('unregistered');
			const stream = newStream();
			await seed(eventPool, stream, [
				{ version: 1, event: 'account-credited', payload: { amount: 10 } },
				{ version: 2, event: 'event-that-was-never-registered', payload: {} },
				{ version: 3, event: 'account-credited', payload: { amount: 20 } },
			]);

			const resolved: unknown[] = [];
			await expect(async () => {
				for await (const batch of eventStore.getEvents(stream, { pool: eventPool, batch: 1 })) {
					resolved.push(...batch);
				}
			}).rejects.toThrow(UnregisteredEventException);

			// Only what precedes the broken event is delivered
			expect(resolved).toHaveLength(1);
			expect(pool.activeConnections()).toBe(0);

			// Nothing is left dangling: the pool keeps serving reads
			const resolvedAfter: EventEnvelope[] = [];
			for await (const batch of eventStore.getEnvelopes(stream, { pool: eventPool })) {
				resolvedAfter.push(...batch);
			}
			expect(resolvedAfter).toHaveLength(3);
		});

		it('should not leak connections when the consumer stops reading early', async () => {
			const eventPool = await newPool('early-exit');
			const stream = await seedLargeStream(eventPool);

			// More iterations than connections in the pool: a leaked connection would time out the acquisition.
			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				for await (const batch of eventStore.getEvents(stream, { pool: eventPool, batch: 1 })) {
					expect(batch).toHaveLength(1);
					break;
				}
				expect(pool.activeConnections()).toBe(0);
			}

			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				for await (const batch of eventStore.getEnvelopes(stream, { pool: eventPool, batch: 1 })) {
					expect(batch).toHaveLength(1);
					break;
				}
				expect(pool.activeConnections()).toBe(0);
			}

			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				for await (const batch of eventStore.getAllEnvelopes({
					since: { year: 2000, month: 1 },
					pool: eventPool,
					batch: 1,
				})) {
					expect(batch).toHaveLength(1);
					break;
				}
				expect(pool.activeConnections()).toBe(0);
			}

			// and the pool still reads the full history afterwards
			let count = 0;
			for await (const batch of eventStore.getEnvelopes(stream, { pool: eventPool, batch: 500 })) {
				count += batch.length;
			}
			expect(count).toBe(3000);
		});

		it('should not leak connections when the consumer throws while reading', async () => {
			const eventPool = await newPool('consumer-throws');
			const stream = await seedLargeStream(eventPool);

			for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
				await expect(async () => {
					for await (const _ of eventStore.getEnvelopes(stream, { pool: eventPool, batch: 1 })) {
						throw new Error('consumer failure');
					}
				}).rejects.toThrow('consumer failure');
				expect(pool.activeConnections()).toBe(0);
			}
		});
	});

	describe('appending', () => {
		it('should append nothing and throw a persistence exception when the collection does not exist', async () => {
			await expect(eventStore.appendEvents(newStream(), 1, events.slice(0, 1), uniquePool('missing'))).rejects.toThrow(
				EventStorePersistenceException,
			);
			expect(pool.activeConnections()).toBe(0);
		});

		it('should throw a persistence exception and release the connection when the collection name cannot be escaped', async () => {
			await expect(eventStore.appendEvents(newStream(), 1, events.slice(0, 1), 'nul\u0000pool')).rejects.toThrow(
				EventStorePersistenceException,
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
					eventStore.appendEvents(newStream(), 1, events.slice(0, 1), uniquePool('missing')),
				).rejects.toThrow(EventStorePersistenceException);
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
			const settle = (stream: EventStream, eventPool: IEventPool, store: MariaDBEventStore = eventStore) =>
				Promise.allSettled(
					Array.from({ length: WRITERS }, () =>
						store.appendEvents(
							stream,
							events.length,
							getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events),
							eventPool,
						),
					),
				);

			const expectExactlyOneWinner = async (
				results: PromiseSettledResult<EventEnvelope[]>[],
				stream: EventStream,
				eventPool: IEventPool,
			) => {
				const fulfilled = results.filter(({ status }) => status === 'fulfilled');
				const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(WRITERS - 1);
				for (const { reason } of rejected) {
					expect(reason).toBeInstanceOf(EventStoreVersionConflictException);
					expect(reason).toMatchObject({
						code: EventSourcingErrorCode.EventStoreVersionConflict,
						streamId: stream.streamId,
						aggregateId: stream.aggregateId,
						pool: eventPool,
						expectedVersion: 0,
						actualVersion: events.length,
					});
				}

				const entities = await pool.query<MariaDBEventEntity[]>(
					`SELECT * FROM ${pool.escapeId(EventCollection.get(eventPool))} WHERE stream_id = ? ORDER BY version ASC`,
					[stream.streamId],
				);
				expect(entities.map(({ version }) => version)).toEqual(events.map((_, index) => index + 1));
			};

			it('should let exactly one writer win and report a version conflict to the others', async () => {
				const concurrentStore = new MariaDBEventStore(eventMap, config({ connectionLimit: WRITERS + 2 }));
				concurrentStore.publish = vi.fn(async () => Promise.resolve());
				await concurrentStore.connect();

				try {
					const eventPool = await newPool('concurrent');
					for (let round = 0; round < 5; round++) {
						const stream = newStream();
						await expectExactlyOneWinner(await settle(stream, eventPool, concurrentStore), stream, eventPool);
					}
				} finally {
					await concurrentStore.disconnect();
				}
			});

			it('should report a version conflict when the race is lost after the version check passed', async () => {
				const concurrentStore = new MariaDBEventStore(eventMap, config({ connectionLimit: WRITERS + 2 }));
				concurrentStore.publish = vi.fn(async () => Promise.resolve());
				await concurrentStore.connect();

				const concurrentPool: Pool = concurrentStore['pool'];
				const getConnection = concurrentPool.getConnection.bind(concurrentPool);

				// Hold every writer right after its version check until all of them have passed it, so that none of
				// them can be stopped by the check and the unique constraint of the table has to decide.
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
						if (typeof sql === 'string' && sql.startsWith('SELECT MAX(version)')) {
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
					const eventPool = await newPool('concurrent-check');
					const stream = newStream();
					await expectExactlyOneWinner(await settle(stream, eventPool, concurrentStore), stream, eventPool);
					expect(versionChecks).toBeGreaterThanOrEqual(WRITERS);
				} finally {
					getConnectionSpy.mockRestore();
					await concurrentStore.disconnect();
				}
			});
		});
	});

	describe('table identifiers', () => {
		it('should quote the collection name in every statement', async () => {
			// A quote in a pool (e.g. a tenant identifier) must never end up in the statement unescaped.
			const eventPool = uniquePool("ten`ant's");
			pools.push(eventPool);
			const stream = newStream();
			const envelopes = getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events);

			await expect(eventStore.ensureCollection(eventPool)).resolves.toBe(EventCollection.get(eventPool));
			await eventStore.appendEvents(stream, envelopes.length, envelopes, eventPool);

			const resolvedEvents: unknown[] = [];
			for await (const batch of eventStore.getEvents(stream, { pool: eventPool })) {
				resolvedEvents.push(...batch);
			}
			expect(resolvedEvents).toEqual(events);

			const resolvedEnvelopes: EventEnvelope[] = [];
			for await (const batch of eventStore.getEnvelopes(stream, { pool: eventPool })) {
				resolvedEnvelopes.push(...batch);
			}
			expect(resolvedEnvelopes).toHaveLength(events.length);

			await expect(eventStore.getEvent(stream, 1, eventPool)).resolves.toEqual(events[0]);
			await expect(eventStore.getEnvelope(stream, 1, eventPool)).resolves.toMatchObject({ event: 'account-opened' });

			const resolvedAllEnvelopes: EventEnvelope[] = [];
			for await (const batch of eventStore.getAllEnvelopes({ since: { year: 2000, month: 1 }, pool: eventPool })) {
				resolvedAllEnvelopes.push(...batch);
			}
			expect(resolvedAllEnvelopes).toHaveLength(events.length);

			const collections: string[] = [];
			for await (const batch of eventStore.listCollections()) {
				collections.push(...batch);
			}
			expect(collections).toContain(EventCollection.get(eventPool));
		});
	});
});
