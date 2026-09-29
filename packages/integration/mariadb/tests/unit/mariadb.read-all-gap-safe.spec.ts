import { randomBytes } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { EventCollection, type EventEnvelope, EventStream, type IEventPool } from '@ocoda/event-sourcing';
import { Account, AccountId, getEventMap, getEvents } from '@ocoda/event-sourcing-testing/unit';
import type { Connection, Pool } from 'mariadb';
import { createEventStore, createTestDatabase, poolOf, rootConnection } from '../support/stores.js';

/**
 * `read-all-gap-safe` for MariaDB, amplified (ADR 0002 evidence, addendum M1).
 *
 * InnoDB copies the active read-write transactions into a new read view with a walk that isn't atomic against
 * concurrent commits, so a read view can show an append without an earlier one that committed just before it. The walk
 * gets longer with every active read-write transaction, so this spec parks prepared XA transactions (which survive
 * their connection) in a database of its own while 8 writers append and readers tail the pool:
 * - the store's `readAll` (the hybrid reader) must read every event exactly once, in increasing positions;
 * - a plain keyset reader runs alongside, and the misses it has are reported (it can miss events; how often depends on
 *   the server and its load, so it is not asserted here; the deterministic negative control is in the event store spec).
 *
 * `ES_TEST_MARIADB_XA_TRANSACTIONS` sets the number of prepared transactions (default 1000),
 * `ES_TEST_MARIADB_GAP_SAFE_ROUNDS` and `ES_TEST_MARIADB_GAP_SAFE_APPENDS` the rounds (default 3) and the appends of
 * every writer per round (default 25), for longer local runs.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const XA_PREFIX = 'ocoda-gap-safe-';
const XA_TRANSACTIONS = Number(process.env.ES_TEST_MARIADB_XA_TRANSACTIONS || 1000);
const WRITERS = 8;
const APPENDS_PER_WRITER = Number(process.env.ES_TEST_MARIADB_GAP_SAFE_APPENDS || 25);
const ROUNDS = Number(process.env.ES_TEST_MARIADB_GAP_SAFE_ROUNDS || 3);

/** Rolls back the prepared XA transactions this spec created, including those of an earlier run that crashed. */
const rollBackPrepared = async (root: Connection): Promise<number> => {
	const prepared = await root.query<{ data: string | Buffer; gtrid_length: number | bigint }[]>('XA RECOVER');
	let rolledBack = 0;
	for (const { data, gtrid_length } of prepared) {
		const gtrid = String(data).slice(0, Number(gtrid_length));
		if (gtrid.startsWith(XA_PREFIX)) {
			await root.query(`XA ROLLBACK '${gtrid}'`);
			rolledBack++;
		}
	}
	return rolledBack;
};

const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> => {
	const all: T[] = [];
	for await (const batch of generator) {
		all.push(...batch);
	}
	return all;
};

describe('MariaDB readAll under amplified read views (prepared XA transactions)', () => {
	let database: Awaited<ReturnType<typeof createTestDatabase>>;
	let root: Connection;
	let created = 0;

	beforeAll(async () => {
		database = await createTestDatabase('xa');
		root = await rootConnection(database.name);
		await rollBackPrepared(root);
		await root.query('CREATE TABLE xa_ballast (id INT PRIMARY KEY) ENGINE=InnoDB');

		// Each prepared transaction needs a connection of its own, which it outlives
		const run = randomBytes(4).toString('hex');
		for (let start = 0; start < XA_TRANSACTIONS; start += 50) {
			await Promise.all(
				Array.from({ length: Math.min(50, XA_TRANSACTIONS - start) }, async (_, offset) => {
					const id = start + offset;
					const xid = `${XA_PREFIX}${run}-${id}`;
					const connection = await rootConnection(database.name);
					try {
						await connection.query(`XA START '${xid}'`);
						await connection.query('INSERT INTO xa_ballast VALUES (?)', [id]);
						await connection.query(`XA END '${xid}'`);
						await connection.query(`XA PREPARE '${xid}'`);
						created++;
					} finally {
						await connection.end();
					}
				}),
			);
		}
	});

	afterAll(async () => {
		if (root) {
			await rollBackPrepared(root);
			await root.end();
		}
		await database?.drop();
	});

	it('hands every event to a tailing readAll exactly once, while a plain keyset reader may miss some', async (context) => {
		expect(created).toBe(XA_TRANSACTIONS);
		const prepared = (await root.query<{ data: string | Buffer }[]>('XA RECOVER')).filter(({ data }) =>
			String(data).startsWith(XA_PREFIX),
		).length;
		expect(prepared).toBe(XA_TRANSACTIONS);

		const eventMap = getEventMap();
		const [event] = getEvents();
		const { store: writer } = createEventStore({ ...database.config, connectionLimit: WRITERS + 2 }, eventMap);
		const { store: reader } = createEventStore({ ...database.config, connectionLimit: 4 }, eventMap);
		await Promise.all([writer.connect(), reader.connect()]);
		const readerPool: Pool = poolOf(reader);

		let plainMisses = 0;
		let settledGaps = 0;
		try {
			for (let round = 1; round <= ROUNDS; round++) {
				const pool: IEventPool = `gap-safe-${round}`;
				await writer.ensureCollection(pool);
				const table = readerPool.escapeId(EventCollection.get(pool));

				let writing = true;
				const writers = Promise.all(
					Array.from({ length: WRITERS }, async (_, index) => {
						const stream = EventStream.for(Account, AccountId.generate());
						const appended: EventEnvelope[] = [];
						for (let append = 0; append < APPENDS_PER_WRITER; append++) {
							const count = 1 + ((index + append) % 3);
							appended.push(
								...(await writer.appendEvents(
									stream,
									Array.from({ length: count }, () => event),
									{
										expectedVersion: appended.length,
										pool,
									},
								)),
							);
						}
						return appended;
					}),
				).finally(() => {
					writing = false;
				});

				// The store's reader, resuming after the last position it read
				const read: EventEnvelope[] = [];
				const tailStore = async () => {
					while (writing) {
						const fromPosition = (read.at(-1)?.metadata.globalPosition ?? 0n) + 1n;
						read.push(...(await drain(reader.readAll({ pool, fromPosition, batch: 7 }))));
						await yieldToEventLoop();
					}
				};

				// A plain keyset reader that trusts every batch, for comparison
				const plain: string[] = [];
				let plainFrom = 1n;
				const plainBatch = async () => {
					const rows = await readerPool.query<{ position: string; event_id: string }[]>(
						`SELECT CAST(e.global_position AS CHAR) AS position, e.event_id FROM ${table} e
						 WHERE e.global_position >= ? ORDER BY e.global_position LIMIT 7`,
						[plainFrom],
					);
					for (const row of rows) {
						plain.push(row.event_id);
						plainFrom = BigInt(row.position) + 1n;
					}
				};
				const tailPlain = async () => {
					while (writing) {
						await plainBatch();
						await yieldToEventLoop();
					}
				};

				const settleSpy = vi.spyOn(reader as unknown as { readHighWaterMark: () => unknown }, 'readHighWaterMark');
				try {
					await Promise.all([tailStore(), tailPlain(), writers]);
					settledGaps += settleSpy.mock.calls.length;
				} finally {
					settleSpy.mockRestore();
				}
				const appended = (await writers).flat();
				let before: number;
				do {
					before = plain.length;
					await plainBatch();
				} while (plain.length > before);
				read.push(
					...(await drain(reader.readAll({ pool, fromPosition: (read.at(-1)?.metadata.globalPosition ?? 0n) + 1n }))),
				);

				const ids = read.map(({ metadata }) => metadata.eventId.value);
				expect(new Set(ids).size, `round ${round}: no event read twice`).toBe(ids.length);
				expect(
					appended.map(({ metadata }) => metadata.eventId.value).filter((id) => !ids.includes(id)),
					`round ${round}: events the tailing readAll never read`,
				).toEqual([]);
				const positions = read.map(({ metadata }) => metadata.globalPosition as bigint);
				expect(positions, `round ${round}: positions 1..n in order`).toEqual(
					appended.map((_, index) => BigInt(index + 1)),
				);

				const plainIds = new Set(plain);
				plainMisses += appended.filter(({ metadata }) => !plainIds.has(metadata.eventId.value)).length;
			}
		} finally {
			await Promise.all([writer.disconnect(), reader.disconnect()]);
		}
		await context.annotate(
			`${XA_TRANSACTIONS} prepared XA transactions: readAll settled ${settledGaps} gap(s) under the high-water mark; the plain keyset reader missed ${plainMisses} event(s) in ${ROUNDS} rounds`,
		);
	});
});
