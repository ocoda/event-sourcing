import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	EventId,
	EventSourcingErrorCode,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	type IEventPool,
	UnregisteredEventException,
} from '@ocoda/event-sourcing';
import { MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
import {
	Account,
	AccountId,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
} from '@ocoda/event-sourcing-testing/unit';
import type { Pool, PoolConnection } from 'mariadb';
import type { MockInstance } from 'vitest';
import { CATALOG, createEventStore, dropTables, poolOf } from '../support/stores.js';

// Pool exhaustion and concurrency scenarios: allow slow tests and setup/teardown hooks.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const uniquePool = (name: string): IEventPool => `mdbfix-${name}-${randomBytes(4).toString('hex')}`;

const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> => {
	const all: T[] = [];
	for await (const batch of generator) {
		all.push(...batch);
	}
	return all;
};

describe(`${MariaDBEventStore.name} resilience`, () => {
	const eventMap = getEventMap();
	const events = getEvents();

	// A small pool makes leaked connections show up as soon as more iterations than connections were executed.
	const POOL_SIZE = 2;
	let eventStore: MariaDBEventStore;
	let pool: Pool;
	const collections: string[] = [];

	const newPool = async (name: string): Promise<IEventPool> => {
		const eventPool = uniquePool(name);
		collections.push(EventCollection.get(eventPool));
		await eventStore.ensureCollection(eventPool);
		return eventPool;
	};

	const newStream = () => EventStream.for(Account, AccountId.generate());

	/**
	 * Seeds rows directly, bypassing the store: the next positions of the table, with explicit columns. Registering the
	 * table again afterwards moves the counter past them.
	 */
	const seed = async (
		eventPool: IEventPool,
		stream: EventStream,
		rows: { version: number; event: string; payload: Record<string, unknown> }[],
	) => {
		const table = pool.escapeId(EventCollection.get(eventPool));
		const [{ last }] = await pool.query<{ last: string }[]>(
			`SELECT CAST(COALESCE(MAX(global_position), 0) AS CHAR) AS last FROM ${table}`,
		);
		await pool.batch(
			`INSERT INTO ${table} (stream_id, version, event, payload, event_id, aggregate_id, occurred_on, global_position)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			rows.map(({ version, event, payload }, index) => [
				stream.streamId,
				version,
				event,
				JSON.stringify(payload),
				EventId.generate().value,
				stream.aggregateId,
				new Date().toISOString().slice(0, 23).replace('T', ' '),
				String(BigInt(last) + BigInt(index) + 1n),
			]),
		);
		await eventStore.ensureCollection(eventPool);
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
		({ store: eventStore } = createEventStore({ connectionLimit: POOL_SIZE, acquireTimeout: 3_000 }, eventMap));
		await eventStore.connect();

		pool = poolOf(eventStore);
	});

	afterAll(async () => {
		await dropTables(pool, collections);
		await eventStore.disconnect();
	});

	describe('reading', () => {
		it('should reject instead of returning an empty history when the collection does not exist', async () => {
			const stream = newStream();
			const missingPool = uniquePool('missing');

			for (const read of [
				() => drain(eventStore.getEvents(stream, { pool: missingPool })),
				() => drain(eventStore.getEnvelopes(stream, { pool: missingPool })),
				() => drain(eventStore.readAll({ pool: missingPool })),
				() => eventStore.getEvent(stream, 1, missingPool),
				() => eventStore.getStreamVersion(stream, missingPool),
			]) {
				const error = await read().catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(EventCollectionNotFoundException);
				expect(error).toMatchObject({ collection: EventCollection.get(missingPool), pool: missingPool });
				expect((error as Error).cause).toMatchObject({ errno: 1146, code: 'ER_NO_SUCH_TABLE' });
			}

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

			// Nothing is left dangling: the pool keeps serving reads, and readAll hands out envelopes without deserializing
			expect(await drain(eventStore.getEnvelopes(stream, { pool: eventPool }))).toHaveLength(3);
			expect((await drain(eventStore.readAll({ pool: eventPool }))).map(({ event }) => event)).toEqual([
				'account-credited',
				'event-that-was-never-registered',
				'account-credited',
			]);
		});

		it('should not leak connections when the consumer stops reading early', async () => {
			const eventPool = await newPool('early-exit');
			const stream = await seedLargeStream(eventPool);

			// More iterations than connections in the pool: a leaked connection would time out the acquisition.
			for (const read of [
				() => eventStore.getEvents(stream, { pool: eventPool, batch: 1 }),
				() => eventStore.getEnvelopes(stream, { pool: eventPool, batch: 1 }),
				() => eventStore.readAll({ pool: eventPool, batch: 1 }),
			]) {
				for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
					for await (const batch of read()) {
						expect(batch).toHaveLength(1);
						break;
					}
					expect(pool.activeConnections()).toBe(0);
				}
			}

			// and the pool still reads the full history afterwards
			expect(await drain(eventStore.getEnvelopes(stream, { pool: eventPool, batch: 500 }))).toHaveLength(3000);
			expect(await drain(eventStore.readAll({ pool: eventPool, batch: 1000 }))).toHaveLength(3000);
		});

		it('should not leak connections when the consumer throws while reading', async () => {
			const eventPool = await newPool('consumer-throws');
			const stream = await seedLargeStream(eventPool);

			for (const read of [
				() => eventStore.getEnvelopes(stream, { pool: eventPool, batch: 1 }),
				() => eventStore.readAll({ pool: eventPool, batch: 1 }),
			]) {
				for (let iteration = 0; iteration < POOL_SIZE * 3; iteration++) {
					await expect(async () => {
						for await (const _ of read()) {
							throw new Error('consumer failure');
						}
					}).rejects.toThrow('consumer failure');
					expect(pool.activeConnections()).toBe(0);
				}
			}
		});
	});

	describe('appending', () => {
		it('should append nothing and throw a persistence exception when the collection does not exist', async () => {
			const missingPool = uniquePool('missing');
			await expect(
				eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: missingPool }),
			).rejects.toMatchObject({
				name: EventStorePersistenceException.name,
				outcome: 'not-persisted',
				cause: expect.any(EventCollectionNotFoundException),
			});
			expect(pool.activeConnections()).toBe(0);
			expect(await drain(eventStore.listCollections())).not.toContain(EventCollection.get(missingPool));
		});

		it('should throw a persistence exception and release the connection when the collection name cannot be escaped', async () => {
			await expect(
				eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: 'nul\u0000pool' }),
			).rejects.toMatchObject({
				name: EventStorePersistenceException.name,
				outcome: 'not-persisted',
				cause: expect.any(Error),
			});
			expect(pool.activeConnections()).toBe(0);
		});

		it("should report a 'not-persisted' outcome for a payload that JSON can't hold, before any I/O", async () => {
			const eventPool = await newPool('encode');
			const stream = newStream();
			const [envelope] = getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events);
			const unencodable = EventEnvelope.from(envelope.event, { amount: 1n } as never, envelope.metadata);
			const getConnection = vi.spyOn(pool, 'getConnection');

			try {
				await expect(
					eventStore.appendEvents(stream, [unencodable], { expectedVersion: 0, pool: eventPool }),
				).rejects.toMatchObject({ outcome: 'not-persisted', cause: expect.any(TypeError) });
				expect(getConnection).not.toHaveBeenCalled();
			} finally {
				getConnection.mockRestore();
			}
			expect(await eventStore.getStreamVersion(stream, eventPool)).toBe(0);
		});

		/** Makes the next connection the store takes from the pool fail its insert, or its commit, with the given error. */
		const failNextConnection = (method: 'insert' | 'commit', error: Error) => {
			const getConnection = pool.getConnection.bind(pool);
			const failures: MockInstance[] = [];
			const getConnectionSpy = vi.spyOn(pool, 'getConnection').mockImplementationOnce(async () => {
				const connection: PoolConnection = await getConnection();
				if (method === 'commit') {
					failures.push(vi.spyOn(connection, 'commit').mockRejectedValue(error));
				} else {
					const query = connection.query.bind(connection);
					failures.push(
						vi.spyOn(connection, 'query').mockImplementation((async (sql: string, values?: unknown) => {
							if (typeof sql === 'string' && sql.startsWith('INSERT INTO')) {
								throw error;
							}
							return query(sql, values);
						}) as PoolConnection['query']),
					);
				}
				return connection;
			});
			return {
				failures,
				restore: () => {
					getConnectionSpy.mockRestore();
					for (const failure of failures) {
						failure.mockRestore();
					}
				},
			};
		};

		it("should report a 'not-persisted' outcome when the insert fails before the commit, and roll back the counter", async () => {
			const eventPool = await newPool('insert-fails');
			const stream = newStream();
			const cause = new Error('insert failure');
			const { failures, restore } = failNextConnection('insert', cause);

			try {
				await expect(
					eventStore.appendEvents(stream, events.slice(0, 2), { expectedVersion: 0, pool: eventPool }),
				).rejects.toMatchObject({
					code: EventSourcingErrorCode.EventStorePersistence,
					collection: EventCollection.get(eventPool),
					outcome: 'not-persisted',
					cause,
				});
				expect(failures[0]).toHaveBeenCalled();
			} finally {
				restore();
			}
			expect(pool.activeConnections()).toBe(0);

			// The counter was rolled back with the rest: the next append takes the first positions
			const appended = await eventStore.appendEvents(stream, events.slice(0, 1), {
				expectedVersion: 0,
				pool: eventPool,
			});
			expect(appended[0].metadata.globalPosition).toBe(1n);
		});

		it("should report an 'unknown' outcome when the commit fails", async () => {
			const eventPool = await newPool('commit-fails');
			const cause = new Error('commit failure');
			const { failures, restore } = failNextConnection('commit', cause);

			try {
				await expect(
					eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
				).rejects.toMatchObject({
					code: EventSourcingErrorCode.EventStorePersistence,
					outcome: 'unknown',
					cause,
				});
				expect(failures[0]).toHaveBeenCalled();
			} finally {
				restore();
			}
			expect(pool.activeConnections()).toBe(0);
		});

		it('should not let a failing rollback hide the original error, and discard the connection', async () => {
			// A table without a catalog row: the version check reads the table, the counter update finds no row
			const eventPool = await newPool('rollback-fails');
			await pool.query(`DELETE FROM ${CATALOG} WHERE name = ?`, [EventCollection.get(eventPool)]);
			const getConnection = pool.getConnection.bind(pool);
			const rollbacks: MockInstance[] = [];
			const destroys: MockInstance[] = [];
			const getConnectionSpy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
				const connection: PoolConnection = await getConnection();
				rollbacks.push(vi.spyOn(connection, 'rollback').mockRejectedValue(new Error('rollback failure')));
				destroys.push(vi.spyOn(connection, 'destroy'));
				return connection;
			});

			try {
				const error = await eventStore
					.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool })
					.catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(EventStorePersistenceException);
				expect(error).toMatchObject({ outcome: 'not-persisted' });
				expect((error as Error).cause).toBeInstanceOf(EventCollectionNotFoundException);
				expect(rollbacks).toHaveLength(1);
				expect(rollbacks[0]).toHaveBeenCalled();
				// A connection whose transaction may still be open never goes back to the pool
				expect(destroys[0]).toHaveBeenCalled();
			} finally {
				getConnectionSpy.mockRestore();
				for (const spy of [...rollbacks, ...destroys]) {
					spy.mockRestore();
				}
			}
			expect(pool.activeConnections()).toBe(0);
		});

		it("should report a 'not-persisted' outcome after a lock wait timeout, and leave no transaction open", async () => {
			const { store: impatient } = createEventStore(
				{ connectionLimit: 1, initSql: 'SET SESSION innodb_lock_wait_timeout = 1' },
				eventMap,
			);
			await impatient.connect();
			const holder = await pool.getConnection();
			try {
				const eventPool = await newPool('lock-wait');
				// Another transaction holds the pool's counter row
				await holder.beginTransaction();
				await holder.query(`SELECT last_position FROM ${CATALOG} WHERE name = ? FOR UPDATE`, [
					EventCollection.get(eventPool),
				]);

				await expect(
					impatient.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
				).rejects.toMatchObject({ outcome: 'not-persisted', cause: expect.objectContaining({ errno: 1205 }) });
				// The store's only connection has no transaction left open
				const [{ open }] = await poolOf(impatient).query<{ open: number }[]>('SELECT @@in_transaction AS open');
				expect(Number(open)).toBe(0);

				await holder.rollback();
				// InnoDB rolls back only the statement on a timeout: the store rolled back the rest
				const [appended] = await impatient.appendEvents(newStream(), events.slice(0, 1), {
					expectedVersion: 0,
					pool: eventPool,
				});
				expect(appended.metadata.globalPosition).toBe(1n);
			} finally {
				await holder.rollback().catch(() => undefined);
				holder.release();
				await impatient.disconnect();
			}
		});

		it('should log counter drift and store nothing when a position is already taken', async () => {
			const eventPool = await newPool('drift');
			await eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool: eventPool });
			await pool.query(`UPDATE ${CATALOG} SET last_position = 0 WHERE name = ?`, [EventCollection.get(eventPool)]);
			const error = vi.spyOn(eventStore['logger'], 'error').mockImplementation(() => undefined);

			try {
				const stream = newStream();
				await expect(
					eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
				).rejects.toMatchObject({ outcome: 'not-persisted', cause: expect.objectContaining({ errno: 1062 }) });
				expect(error).toHaveBeenCalledWith(expect.stringMatching(/ux_global_position.*ensureCollection\(\) heals it/));
				expect(await eventStore.getStreamVersion(stream, eventPool)).toBe(0);
			} finally {
				error.mockRestore();
			}
		});

		describe('concurrent writers', () => {
			const WRITERS = 8;
			const settle = (stream: EventStream, eventPool: IEventPool, store: MariaDBEventStore) =>
				Promise.allSettled(
					Array.from({ length: WRITERS }, () =>
						store.appendEvents(stream, getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events), {
							expectedVersion: 0,
							pool: eventPool,
						}),
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
					});
					// The version check reports the head it read; a race lost on the (stream, version) key doesn't know it
					if (reason.actualVersion === undefined) {
						expect(reason.cause).toMatchObject({ errno: 1062 });
					} else {
						expect(reason.actualVersion).toBe(events.length);
					}
				}

				const entities = await pool.query<{ version: number }[]>(
					`SELECT version FROM ${pool.escapeId(EventCollection.get(eventPool))} WHERE stream_id = ? ORDER BY version ASC`,
					[stream.streamId],
				);
				expect(entities.map(({ version }) => version)).toEqual(events.map((_, index) => index + 1));
			};

			/** The positions of a pool are 1..n, without holes: a lost race rolls its counter update back. */
			const expectNoHoles = async (eventPool: IEventPool, count: number) => {
				expect(
					(await drain(eventStore.readAll({ pool: eventPool }))).map(({ metadata }) => metadata.globalPosition),
				).toEqual(Array.from({ length: count }, (_, index) => BigInt(index + 1)));
			};

			it('should let exactly one writer win and report a version conflict to the others', async () => {
				const { store: concurrentStore } = createEventStore({ connectionLimit: WRITERS + 2 }, eventMap);
				await concurrentStore.connect();

				try {
					const eventPool = await newPool('concurrent');
					for (let round = 0; round < 5; round++) {
						const stream = newStream();
						await expectExactlyOneWinner(await settle(stream, eventPool, concurrentStore), stream, eventPool);
					}
					await expectNoHoles(eventPool, 5 * events.length);
				} finally {
					await concurrentStore.disconnect();
				}
			});

			it('should report a version conflict when the race is lost after the version check passed', async () => {
				const { store: concurrentStore, publish } = createEventStore({ connectionLimit: WRITERS + 2 }, eventMap);
				await concurrentStore.connect();

				// Hold every writer right after its version check until all of them have passed it, so that none of
				// them can be stopped by the check and the unique key of the table has to decide.
				let versionChecks = 0;
				let releaseWriters: () => void = () => undefined;
				const allChecked = new Promise<void>((resolve) => {
					releaseWriters = resolve;
				});
				const getStreamVersion = concurrentStore.getStreamVersion.bind(concurrentStore);
				const spy = vi.spyOn(concurrentStore, 'getStreamVersion').mockImplementation(async (...args) => {
					const version = await getStreamVersion(...args);
					versionChecks++;
					if (versionChecks === WRITERS) {
						releaseWriters();
					}
					if (versionChecks <= WRITERS) {
						await allChecked;
					}
					return version;
				});

				try {
					const eventPool = await newPool('concurrent-check');
					const stream = newStream();
					const results = await settle(stream, eventPool, concurrentStore);
					await expectExactlyOneWinner(results, stream, eventPool);
					expect(versionChecks).toBe(WRITERS);
					for (const result of results) {
						if (result.status === 'rejected') {
							expect(result.reason.actualVersion).toBeUndefined();
						}
					}
					// Only the winner published
					expect(publish).toHaveBeenCalledTimes(events.length);
					await expectNoHoles(eventPool, events.length);
				} finally {
					spy.mockRestore();
					await concurrentStore.disconnect();
				}
			});
		});
	});

	describe('table identifiers', () => {
		it('should quote the collection name in every statement', async () => {
			// A quote in a pool (e.g. a tenant identifier) must never end up in the statement unescaped.
			const eventPool = uniquePool("ten`ant's");
			collections.push(EventCollection.get(eventPool));
			const stream = newStream();
			const envelopes = getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events);

			await expect(eventStore.ensureCollection(eventPool)).resolves.toBe(EventCollection.get(eventPool));
			await eventStore.appendEvents(stream, envelopes, { expectedVersion: 0, pool: eventPool });

			expect(await drain(eventStore.getEvents(stream, { pool: eventPool }))).toEqual(events);
			expect(await drain(eventStore.getEnvelopes(stream, { pool: eventPool }))).toHaveLength(events.length);
			await expect(eventStore.getEvent(stream, 1, eventPool)).resolves.toEqual(events[0]);
			await expect(eventStore.getEnvelope(stream, 1, eventPool)).resolves.toMatchObject({ event: 'account-opened' });
			await expect(eventStore.getStreamVersion(stream, eventPool)).resolves.toBe(events.length);
			expect(await drain(eventStore.readAll({ pool: eventPool }))).toHaveLength(events.length);
			expect(await drain(eventStore.listCollections())).toContain(EventCollection.get(eventPool));
		});
	});
});
