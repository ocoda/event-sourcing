import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	EventId,
	EventSourcingErrorCode,
	EventStoreCollectionCreationException,
	EventStoreSchemaException,
	EventStream,
	ExpectedVersion,
	type IEventPool,
} from '@ocoda/event-sourcing';
import { MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
import {
	Account,
	AccountId,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
} from '@ocoda/event-sourcing-testing/unit';
import type { Pool } from 'mariadb';
import { v1EventTableDdl } from '../fixtures/schema-v1.js';
import { CATALOG, createEventStore, createTestDatabase, dropTables, poolOf } from '../support/stores.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const uniquePool = (name: string): IEventPool => `mdbes-${name}-${randomBytes(4).toString('hex')}`;

const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> => {
	const all: T[] = [];
	for await (const batch of generator) {
		all.push(...batch);
	}
	return all;
};

const newStream = () => EventStream.for(Account, AccountId.generate());

describe(MariaDBEventStore, () => {
	const eventMap = getEventMap();
	const events = getEvents();
	let store: MariaDBEventStore;
	let pool: Pool;
	const collections: string[] = [];

	const newPool = async (name: string): Promise<IEventPool> => {
		const eventPool = uniquePool(name);
		collections.push(EventCollection.get(eventPool));
		await store.ensureCollection(eventPool);
		return eventPool;
	};

	const catalogRow = async (collection: string) =>
		(
			await pool.query<{ kind: string; schema_version: number; last_position: string }[]>(
				`SELECT kind, schema_version, CAST(last_position AS CHAR) AS last_position FROM ${CATALOG} WHERE name = ?`,
				[collection],
			)
		)[0];

	beforeAll(async () => {
		({ store } = createEventStore({}, eventMap));
		await store.connect();
		pool = poolOf(store);
	});

	afterAll(async () => {
		await dropTables(pool, collections);
		await store.disconnect();
	});

	describe('appending', () => {
		it('stores the events in the v2 columns, with their positions, milliseconds, headers and event version', async () => {
			const eventPool = await newPool('columns');
			const stream = newStream();
			const [imported] = getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events);
			const importedWithMetadata = EventEnvelope.from(imported.event, imported.payload, {
				...imported.metadata,
				eventId: EventId.generate(new Date('2024-02-03T04:05:06.789Z')),
				occurredOn: new Date('2024-02-03T04:05:06.789Z'),
				headers: { $traceparent: '00-abc', tenant: 'acme' },
				eventVersion: 3,
			});

			const appended = await store.appendEvents(stream, [importedWithMetadata, events[1]], {
				expectedVersion: ExpectedVersion.NoStream,
				pool: eventPool,
				metadata: { correlationId: 'corr', headers: { tenant: 'other' } },
			});

			const rows = await pool.query<Record<string, unknown>[]>(
				`SELECT stream_id, version, event, payload, event_id, aggregate_id, CAST(occurred_on AS CHAR) AS occurred_on,
					correlation_id, causation_id, CAST(global_position AS CHAR) AS global_position, headers, event_version
				 FROM ${pool.escapeId(EventCollection.get(eventPool))} ORDER BY version`,
			);
			expect(rows).toEqual([
				{
					stream_id: stream.streamId,
					version: 1,
					event: 'account-opened',
					payload: imported.payload,
					event_id: importedWithMetadata.metadata.eventId.value,
					aggregate_id: stream.aggregateId,
					occurred_on: '2024-02-03 04:05:06.789',
					correlation_id: 'corr',
					causation_id: null,
					global_position: '1',
					headers: { $traceparent: '00-abc', tenant: 'acme' },
					event_version: 3,
				},
				{
					stream_id: stream.streamId,
					version: 2,
					event: 'account-credited',
					payload: eventMap.serializeEvent(events[1]),
					event_id: appended[1].metadata.eventId.value,
					aggregate_id: stream.aggregateId,
					occurred_on: appended[1].metadata.occurredOn.toISOString().slice(0, 23).replace('T', ' '),
					correlation_id: 'corr',
					causation_id: null,
					global_position: '2',
					headers: { tenant: 'other' },
					event_version: null,
				},
			]);
			expect(appended.map(({ metadata }) => metadata.globalPosition)).toEqual([1n, 2n]);
			await expect(catalogRow(EventCollection.get(eventPool))).resolves.toEqual({
				kind: 'events',
				schema_version: 2,
				last_position: '2',
			});

			// And reads them back the same way, in every read
			const [read] = await drain(store.getEnvelopes(stream, { pool: eventPool }));
			expect(read.metadata).toEqual({ ...importedWithMetadata.metadata, correlationId: 'corr', globalPosition: 1n });
			await expect(store.getEnvelope(stream, 1, eventPool)).resolves.toEqual(read);
			expect((await drain(store.readAll({ pool: eventPool })))[0]).toEqual(read);
		});

		it('numbers each pool on its own, and keeps the counter at the last position', async () => {
			const [first, second] = [await newPool('count-a'), await newPool('count-b')];

			for (const [index, eventPool] of [first, first, second, first].entries()) {
				await store.appendEvents(newStream(), events.slice(0, index + 1), {
					expectedVersion: ExpectedVersion.NoStream,
					pool: eventPool,
				});
			}

			expect((await drain(store.readAll({ pool: first }))).map(({ metadata }) => metadata.globalPosition)).toEqual([
				1n,
				2n,
				3n,
				4n,
				5n,
				6n,
				7n,
			]);
			await expect(catalogRow(EventCollection.get(first))).resolves.toMatchObject({ last_position: '7' });
			await expect(catalogRow(EventCollection.get(second))).resolves.toMatchObject({ last_position: '3' });
		});

		it('publishes the stored envelopes through the store context', async () => {
			const { store: publishing, publish } = createEventStore({}, eventMap);
			await publishing.connect();
			try {
				const eventPool = await newPool('publish');
				await publishing.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool: eventPool });
				expect(publish).toHaveBeenCalledTimes(2);
				expect(publish.mock.calls.map(([envelope]) => envelope.metadata.globalPosition)).toEqual([1n, 2n]);
			} finally {
				await publishing.disconnect();
			}
		});
	});

	describe('ensureCollection', () => {
		it('registers the table once, and heals a counter that is behind the stored positions', async () => {
			const eventPool = await newPool('heal');
			const collection = EventCollection.get(eventPool);
			await store.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0, pool: eventPool });

			await pool.query(`UPDATE ${CATALOG} SET last_position = 1 WHERE name = ?`, [collection]);
			// The next append collides with a stored position: counter drift, nothing is stored
			await expect(
				store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
			).rejects.toMatchObject({ code: EventSourcingErrorCode.EventStorePersistence, outcome: 'not-persisted' });

			await expect(store.ensureCollection(eventPool)).resolves.toBe(collection);
			await expect(catalogRow(collection)).resolves.toMatchObject({ last_position: '3' });
			const [appended] = await store.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				pool: eventPool,
			});
			expect(appended.metadata.globalPosition).toBe(4n);
		});

		it('registers the table while appends to it run, without a deadlock (an instance that boots while others write)', async () => {
			const eventPool = await newPool('booting');
			const { store: booting } = createEventStore({}, eventMap);
			await booting.connect();
			try {
				let writing = true;
				const writers = Promise.all(
					Array.from({ length: 4 }, async () => {
						const stream = newStream();
						for (let version = 0; version < 40; version++) {
							await store.appendEvents(stream, events.slice(0, 1), { expectedVersion: version, pool: eventPool });
						}
					}),
				).finally(() => {
					writing = false;
				});
				let ensured = 0;
				while (writing) {
					await booting.ensureCollection(eventPool);
					ensured++;
				}
				await writers;

				expect(ensured).toBeGreaterThan(0);
				await expect(catalogRow(EventCollection.get(eventPool))).resolves.toMatchObject({ last_position: '160' });
			} finally {
				await booting.disconnect();
			}
		});

		it('continues the positions of a pool whose table was dropped and created again', async () => {
			const eventPool = await newPool('recreate');
			const collection = EventCollection.get(eventPool);
			await store.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool: eventPool });

			await pool.query(`DROP TABLE ${pool.escapeId(collection)}`);
			await store.ensureCollection(eventPool);
			const stream = newStream();
			await store.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: eventPool });

			// A reader from the start meets the gap below position 3, which is permanent
			expect((await drain(store.readAll({ pool: eventPool }))).map(({ metadata }) => metadata.globalPosition)).toEqual([
				3n,
			]);
			expect(
				(await drain(store.readAll({ pool: eventPool, fromPosition: 2n }))).map(
					({ metadata }) => metadata.globalPosition,
				),
			).toEqual([3n]);
		});

		it('finishes a creation that crashed before the table was registered', async () => {
			const eventPool = uniquePool('crashed');
			const collection = EventCollection.get(eventPool);
			collections.push(collection);
			await store.ensureCollection(eventPool);
			await pool.query(`DELETE FROM ${CATALOG} WHERE name = ?`, [collection]);
			await expect(
				store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
			).rejects.toMatchObject({ outcome: 'not-persisted', cause: expect.any(EventCollectionNotFoundException) });

			await expect(store.ensureCollection(eventPool)).resolves.toBe(collection);
			await expect(
				store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
			).resolves.toHaveLength(1);
		});

		it('rejects a pool whose table name would exceed 64 characters', async () => {
			const error = await store.ensureCollection('p'.repeat(58)).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(EventStoreCollectionCreationException);
			expect(((error as Error).cause as Error).message).toMatch(/65 characters, MariaDB allows 64/);
			await expect(store.ensureCollection('p'.repeat(57))).resolves.toBe(`${'p'.repeat(57)}-events`);
			collections.push(`${'p'.repeat(57)}-events`);
		});

		it("with ddl: 'none', checks and registers the tables and creates nothing", async () => {
			const database = await createTestDatabase('ddl');
			const auto = createEventStore({ ...database.config }, eventMap).store;
			const none = createEventStore({ ...database.config, ddl: 'none' }, eventMap).store;
			await Promise.all([auto.connect(), none.connect()]);
			try {
				// No catalog
				const noCatalog = await none.ensureCollection('tenant').catch((error: unknown) => error);
				expect(noCatalog).toBeInstanceOf(EventStoreSchemaException);
				expect(noCatalog).toMatchObject({ found: 'missing', collection: 'tenant-events' });
				expect((noCatalog as EventStoreSchemaException).remedy).toMatch(
					/CREATE TABLE IF NOT EXISTS `event_sourcing_collections`/,
				);
				expect(await drain(none.listCollections())).toEqual([]);

				// A catalog, no table
				await auto.ensureCollection('other');
				await expect(none.ensureCollection('tenant')).rejects.toMatchObject({
					found: 'missing',
					remedy: expect.stringMatching(/CREATE TABLE IF NOT EXISTS `tenant-events`/),
				});

				// A table that a DBA created from the remedy, not registered yet
				const [, table, register] = ((noCatalog as EventStoreSchemaException).remedy.split('run:\n')[1] ?? '')
					.split(';\n')
					.map((statement) => statement.replace(/;$/, ''));
				const admin = poolOf(auto);
				await admin.query(table);
				await expect(none.ensureCollection('tenant')).resolves.toBe('tenant-events');
				expect(register).toMatch(/^INSERT INTO `event_sourcing_collections`/);
				expect(await drain(none.listCollections())).toEqual(['other-events', 'tenant-events']);
				await expect(
					none.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: 'tenant' }),
				).resolves.toHaveLength(1);
			} finally {
				await Promise.all([auto.disconnect(), none.disconnect()]);
				await database.drop();
			}
		});
	});

	describe('listCollections', () => {
		it('lists the event collections of the catalog in batches, and no 3.x tables or snapshot collections', async () => {
			const database = await createTestDatabase('list');
			const local = createEventStore({ ...database.config }, eventMap).store;
			await local.connect();
			try {
				const admin = poolOf(local);
				await admin.query(v1EventTableDdl('legacy-events'));
				for (const name of ['c', 'a', 'b']) {
					await local.ensureCollection(name);
				}
				await admin.query(`INSERT INTO ${CATALOG} (name, kind, schema_version) VALUES ('snapshots', 'snapshots', 2)`);

				const batches: string[][] = [];
				for await (const batch of local.listCollections({ batch: 2 })) {
					batches.push(batch);
				}
				expect(batches).toEqual([['a-events', 'b-events'], ['c-events']]);
			} finally {
				await local.disconnect();
				await database.drop();
			}
		});
	});

	describe('reads', () => {
		it('rejects reads of a missing table with an EventCollectionNotFoundException, and of a 3.x table with an EventStoreSchemaException', async () => {
			const missing = uniquePool('missing');
			const stream = newStream();
			for (const read of [
				() => store.getStreamVersion(stream, missing),
				() => store.getEnvelope(stream, 1, missing),
				() => drain(store.getEnvelopes(stream, { pool: missing })),
				() => drain(store.readAll({ pool: missing })),
			]) {
				await expect(read()).rejects.toMatchObject({
					code: EventSourcingErrorCode.EventCollectionNotFound,
					collection: EventCollection.get(missing),
					pool: missing,
				});
			}

			const legacy = uniquePool('legacy');
			collections.push(EventCollection.get(legacy));
			await pool.query(v1EventTableDdl(EventCollection.get(legacy)));
			for (const read of [
				() => store.getEnvelope(stream, 1, legacy),
				() => drain(store.getEnvelopes(stream, { pool: legacy })),
				() => drain(store.readAll({ pool: legacy })),
			]) {
				await expect(read()).rejects.toMatchObject({ code: EventSourcingErrorCode.EventStoreSchema, found: 'v1' });
			}
		});
	});

	describe('readAll', () => {
		/**
		 * Hides the rows at the given positions from the next plain batch query, the way a torn InnoDB read view does:
		 * the batch shows later positions without an earlier one that is committed.
		 */
		const tearNextBatch = (target: MariaDBEventStore, hidden: readonly bigint[]) => {
			const targetPool = poolOf(target);
			const query = targetPool.query.bind(targetPool);
			let torn = false;
			return vi.spyOn(targetPool, 'query').mockImplementation((async (sql: string, values?: unknown) => {
				const rows = await query(sql, values);
				if (!torn && typeof sql === 'string' && sql.includes('e.global_position >= ?') && !sql.includes('<= ?')) {
					torn = true;
					return (rows as { global_position: string }[]).filter(
						({ global_position }) => !hidden.includes(BigInt(global_position)),
					);
				}
				return rows;
			}) as Pool['query']);
		};

		/** The 3.x-style plain keyset reader that the plan first specified: it trusts every batch. */
		class PlainReaderEventStore extends MariaDBEventStore {
			async *readAll(filter?: Parameters<MariaDBEventStore['readAll']>[0]) {
				let from = filter?.fromPosition ?? 0n;
				const batch = filter?.batch ?? 100;
				while (true) {
					const rows = await this['readPositions'](EventCollection.get(filter?.pool), filter?.pool, from, batch);
					if (rows.length === 0) {
						return;
					}
					yield rows as unknown as EventEnvelope[];
					from = BigInt(rows[rows.length - 1].global_position) + 1n;
					if (rows.length < batch) {
						return;
					}
				}
			}
		}

		const seedPool = async (count: number) => {
			const eventPool = await newPool('torn');
			for (let index = 0; index < count; index++) {
				await store.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool });
			}
			return eventPool;
		};

		it('delivers a torn batch only up to its gap, and settles a gap at its start under the high-water mark', async () => {
			const eventPool = await seedPool(6);
			const batchesOf = async (hidden: bigint[]) => {
				const spy = tearNextBatch(store, hidden);
				try {
					const batches: (bigint | undefined)[][] = [];
					for await (const batch of store.readAll({ pool: eventPool, batch: 10 })) {
						batches.push(batch.map(({ metadata }) => metadata.globalPosition));
					}
					return batches;
				} finally {
					spy.mockRestore();
				}
			};

			// The prefix before the gap, then a fresh batch from the gap on
			expect(await batchesOf([3n])).toEqual([
				[1n, 2n],
				[3n, 4n, 5n, 6n],
			]);
			// A gap at the start: the batch under the high-water mark, which shows every committed position
			expect(await batchesOf([1n, 2n])).toEqual([[1n, 2n, 3n, 4n, 5n, 6n]]);
		});

		it('negative control: a plain keyset reader skips the event that a torn batch hid', async () => {
			const eventPool = await seedPool(6);
			const plain = new PlainReaderEventStore(store['context'], store['options']);
			await plain.connect();
			const spy = tearNextBatch(plain, [3n]);
			try {
				const read = (await drain(plain.readAll({ pool: eventPool, batch: 10 }))) as unknown as {
					global_position: string;
				}[];
				expect(read.map(({ global_position }) => global_position)).toEqual(['1', '2', '4', '5', '6']);
			} finally {
				spy.mockRestore();
				await plain.disconnect();
			}
		});

		it('reads across a permanent gap, from any position, in batches of any size', async () => {
			const eventPool = await seedPool(5);
			await pool.query(`DELETE FROM ${pool.escapeId(EventCollection.get(eventPool))} WHERE global_position = 2`);

			for (const batch of [1, 2, 10]) {
				expect(
					(await drain(store.readAll({ pool: eventPool, batch }))).map(({ metadata }) => metadata.globalPosition),
				).toEqual([1n, 3n, 4n, 5n]);
				expect(
					(await drain(store.readAll({ pool: eventPool, batch, fromPosition: 2n }))).map(
						({ metadata }) => metadata.globalPosition,
					),
				).toEqual([3n, 4n, 5n]);
			}
			expect(await drain(store.readAll({ pool: eventPool, fromPosition: 6n }))).toEqual([]);
		});

		it('rejects a read at a gap of a table without a catalog row', async () => {
			const eventPool = await seedPool(3);
			await pool.query(`DELETE FROM ${pool.escapeId(EventCollection.get(eventPool))} WHERE global_position = 1`);
			await pool.query(`DELETE FROM ${CATALOG} WHERE name = ?`, [EventCollection.get(eventPool)]);

			await expect(drain(store.readAll({ pool: eventPool }))).rejects.toBeInstanceOf(EventCollectionNotFoundException);
		});

		it('reads positions above a counter that drifted behind them, and warns', async () => {
			const eventPool = await seedPool(3);
			const collection = EventCollection.get(eventPool);
			await pool.query(`DELETE FROM ${pool.escapeId(collection)} WHERE global_position = 1`);
			await pool.query(`UPDATE ${CATALOG} SET last_position = 0 WHERE name = ?`, [collection]);
			const warn = vi.spyOn(store['logger'], 'warn').mockImplementation(() => undefined);
			try {
				expect(
					(await drain(store.readAll({ pool: eventPool }))).map(({ metadata }) => metadata.globalPosition),
				).toEqual([2n, 3n]);
				expect(warn).toHaveBeenCalledWith(expect.stringMatching(/above its counter \(0\)/));
			} finally {
				warn.mockRestore();
			}
		});

		it('rejects an invalid batch or position before it reads', async () => {
			await expect(drain(store.readAll({ batch: 0 }))).rejects.toThrow(RangeError);
			await expect(drain(store.readAll({ fromPosition: -1n }))).rejects.toThrow(RangeError);
		});
	});

	describe('connection options', () => {
		it('keeps positions exact with bigIntAsNumber and insertIdAsNumber', async () => {
			const { store: numbers } = createEventStore({ bigIntAsNumber: true, insertIdAsNumber: true }, eventMap);
			await numbers.connect();
			try {
				const eventPool = uniquePool('numbers');
				collections.push(EventCollection.get(eventPool));
				await numbers.ensureCollection(eventPool);
				// Beyond Number.MAX_SAFE_INTEGER: a number would lose the last digits
				await pool.query(`UPDATE ${CATALOG} SET last_position = 9007199254740993 WHERE name = ?`, [
					EventCollection.get(eventPool),
				]);
				const appended = await numbers.appendEvents(newStream(), events.slice(0, 2), {
					expectedVersion: 0,
					pool: eventPool,
				});
				expect(appended.map(({ metadata }) => metadata.globalPosition)).toEqual([9007199254740994n, 9007199254740995n]);
				expect(
					(await drain(numbers.readAll({ pool: eventPool, fromPosition: 9007199254740994n }))).map(
						({ metadata }) => metadata.globalPosition,
					),
				).toEqual([9007199254740994n, 9007199254740995n]);
			} finally {
				await numbers.disconnect();
			}
		});

		it('appends in sessions with innodb_snapshot_isolation on, also when they race', async (context) => {
			const [{ supported }] = await pool.query<{ supported: bigint | number }[]>(
				"SELECT COUNT(*) AS supported FROM information_schema.SYSTEM_VARIABLES WHERE VARIABLE_NAME = 'INNODB_SNAPSHOT_ISOLATION'",
			);
			if (Number(supported) === 0) {
				context.skip('innodb_snapshot_isolation needs MariaDB 10.6.18, 10.11.8, 11.4.2 or later');
				return;
			}
			const { store: isolated } = createEventStore(
				{ initSql: 'SET SESSION innodb_snapshot_isolation = ON', connectionLimit: 10 },
				eventMap,
			);
			await isolated.connect();
			try {
				const eventPool = await newPool('snapshot-isolation');
				const stream = newStream();
				const appended = await Promise.all(
					Array.from({ length: 8 }, () =>
						isolated.appendEvents(stream, events.slice(0, 1), {
							expectedVersion: ExpectedVersion.Any,
							pool: eventPool,
						}),
					),
				);
				expect(
					appended
						.flat()
						.map(({ metadata }) => metadata.version)
						.sort(),
				).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
				expect(
					(await drain(isolated.readAll({ pool: eventPool }))).map(({ metadata }) => metadata.globalPosition),
				).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
			} finally {
				await isolated.disconnect();
			}
		});
	});

	describe('connecting', () => {
		it('fails to connect to a server that is not there, and disconnects only once', async () => {
			const { store: unreachable } = createEventStore({ port: 1, connectTimeout: 500, acquireTimeout: 1000 }, eventMap);
			await expect(unreachable.connect()).rejects.toBeDefined();
			await expect(unreachable.disconnect()).resolves.toBeUndefined();

			const { store: twice } = createEventStore({}, eventMap);
			await expect(twice.disconnect()).resolves.toBeUndefined();
			await twice.connect();
			await twice.disconnect();
			await expect(twice.disconnect()).resolves.toBeUndefined();
			await expect(twice.getStreamVersion(newStream())).rejects.toThrow(/not connected/);
		});
	});
});
