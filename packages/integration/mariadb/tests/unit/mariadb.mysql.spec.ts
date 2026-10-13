import { EventCollection, EventStream, SnapshotStream, UnsupportedOperationException } from '@ocoda/event-sourcing';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { Account, AccountId, getEventMap, getEvents, mariadbTestConfig } from '@ocoda/event-sourcing-testing/unit';
import {
	createEventStore,
	createSnapshotStore,
	createTestDatabase,
	onMySQL,
	rootConnection,
} from '../support/stores.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> => {
	const all: T[] = [];
	for await (const batch of generator) {
		all.push(...batch);
	}
	return all;
};

// What the stores do differently on MySQL. Every spec of this package also runs on MySQL (ES_TEST_MARIADB_FLAVOR=mysql).
describe.runIf(onMySQL)('MariaDB stores on MySQL', () => {
	const eventMap = getEventMap();
	const events = getEvents();
	let database: Awaited<ReturnType<typeof createTestDatabase>>;

	beforeAll(async () => {
		database = await createTestDatabase('mysql');
	});

	afterAll(async () => {
		await database?.drop();
	});

	const columnTypes = async (table: string) => {
		const root = await rootConnection();
		try {
			const rows = await root.query<{ COLUMN_NAME: string; DATA_TYPE: string }[]>(
				`SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
				 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN ('payload', 'headers') ORDER BY COLUMN_NAME`,
				[database.name, table],
			);
			return Object.fromEntries(rows.map(({ COLUMN_NAME, DATA_TYPE }) => [COLUMN_NAME, DATA_TYPE.toLowerCase()]));
		} finally {
			await root.end();
		}
	};

	it('authenticates the test user with caching_sha2_password, the only built-in authentication of MySQL 9', async () => {
		const root = await rootConnection();
		try {
			const [{ plugin }] = await root.query<{ plugin: string }[]>('SELECT plugin FROM mysql.user WHERE user = ?', [
				mariadbTestConfig().user,
			]);
			expect(plugin).toBe('caching_sha2_password');
		} finally {
			await root.end();
		}
	});

	it('stores JSON as text: doubles keep their digits and objects the order of their keys', async () => {
		const { store } = createEventStore({ database: database.name }, eventMap);
		const snapshots = createSnapshotStore({ database: database.name });
		await store.connect();
		await snapshots.connect();
		try {
			await store.ensureCollection('json');
			await snapshots.ensureCollection('json');
			await expect(columnTypes(EventCollection.get('json'))).resolves.toEqual({
				headers: 'longtext',
				payload: 'longtext',
			});
			await expect(columnTypes('json-snapshots')).resolves.toEqual({ payload: 'longtext' });

			const stream = EventStream.for(Account, AccountId.generate());
			const [opened] = events;
			await store.appendEvents(stream, [opened], {
				expectedVersion: 0,
				pool: 'json',
				metadata: { headers: { z: 1, a: 0.1 + 0.2 } },
			});
			const [envelope] = await drain(store.getEnvelopes(stream, { pool: 'json' }));
			expect(Object.keys(envelope.metadata.headers ?? {})).toEqual(['z', 'a']);
			expect(envelope.metadata.headers).toEqual({ z: 1, a: 0.30000000000000004 });

			const snapshotStream = SnapshotStream.for(Account, AccountId.generate());
			await snapshots.appendSnapshot(snapshotStream, 1, { zebra: 1 - Number.EPSILON / 2, apple: 2 }, 'json');
			const snapshot = await snapshots.getLastSnapshot(snapshotStream, 'json');
			expect(Object.keys(snapshot ?? {})).toEqual(['zebra', 'apple']);
			expect(snapshot).toEqual({ zebra: 0.9999999999999999, apple: 2 });
		} finally {
			await snapshots.disconnect();
			await store.disconnect();
		}
	});

	it('runs no statement that the server warns about, such as deprecated syntax (1287)', async () => {
		const own = await createTestDatabase('warnings');
		try {
			const { store } = createEventStore({ database: own.name }, eventMap);
			const snapshots = createSnapshotStore({ database: own.name });
			await store.connect();
			await snapshots.connect();
			try {
				const stream = EventStream.for(Account, AccountId.generate());
				await store.ensureCollection();
				await store.appendEvents(stream, events.slice(0, 2), { expectedVersion: 0 });
				await store.getStreamVersion(stream);
				await drain(store.getEvents(stream));
				await drain(store.readAll());
				await drain(store.listCollections());
				await store.ensureCollection();

				const snapshotStream = SnapshotStream.for(Account, AccountId.generate());
				await snapshots.ensureCollection();
				await snapshots.appendSnapshot(snapshotStream, 1, { balance: 1 });
				await snapshots.appendSnapshot(snapshotStream, 2, { balance: 2 });
				await snapshots.getLastSnapshot(snapshotStream);
				await drain(snapshots.getSnapshots(snapshotStream));
				await drain(snapshots.listCollections());
			} finally {
				await snapshots.disconnect();
				await store.disconnect();
			}

			const root = await rootConnection();
			try {
				const warned = await root.query<{ DIGEST_TEXT: string; SUM_WARNINGS: bigint }[]>(
					`SELECT DIGEST_TEXT, SUM_WARNINGS FROM performance_schema.events_statements_summary_by_digest
					 WHERE SCHEMA_NAME = ? AND SUM_WARNINGS > 0`,
					[own.name],
				);
				// The catalog's CREATE TABLE IF NOT EXISTS notes (1050) that the catalog exists
				expect(warned.filter(({ DIGEST_TEXT }) => !/^CREATE TABLE IF NOT EXISTS/i.test(DIGEST_TEXT))).toEqual([]);
			} finally {
				await root.end();
			}
		} finally {
			await own.drop();
		}
	});

	it('refuses to migrate from 3.x, before it changes anything', async () => {
		const own = await createTestDatabase('migrate');
		const { driver: _driver, ...config } = { driver: undefined, ...mariadbTestConfig(), database: own.name };
		try {
			const refused = { name: 'UnsupportedOperationException', message: expect.stringMatching(/other than MariaDB/) };
			await expect(MariaDBEventStore.migrate(config)).rejects.toMatchObject(refused);
			await expect(MariaDBSnapshotStore.migrate(config, { dryRun: true })).rejects.toBeInstanceOf(
				UnsupportedOperationException,
			);
			const snapshots = createSnapshotStore({ database: own.name });
			await snapshots.connect();
			try {
				await expect(snapshots.migrate()).rejects.toMatchObject(refused);
			} finally {
				await snapshots.disconnect();
			}

			const root = await rootConnection();
			try {
				await expect(
					root.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [own.name]),
				).resolves.toEqual([]);
			} finally {
				await root.end();
			}
		} finally {
			await own.drop();
		}
	});
});
