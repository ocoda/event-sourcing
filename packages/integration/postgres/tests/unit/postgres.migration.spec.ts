import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
	EventCollection,
	EventStream,
	ExpectedVersion,
	type MigrationReport,
	SnapshotCollection,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { Account, AccountId, getEvents, postgresTestConfig } from '@ocoda/event-sourcing-testing/unit';
import { Client, DatabaseError, Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { runMigration } from '../../lib/migration/migrate.js';
import { migrationLockKey } from '../../lib/migration/plan.js';
import { catalogStatement } from '../../lib/postgres.schema.js';
import {
	type IndexVariant,
	type V1EventRow,
	type V1SnapshotRow,
	ulidAt,
	ulidTime,
	v1EventInsert,
	v1EventTableStatements,
	v1SnapshotInsert,
	v1SnapshotTableStatements,
} from '../fixtures/schema-v1.js';
import { createEventStore, createSnapshotStore } from '../support/stores.js';

// migrate() (ADR 0002 §6, with the rewrite of the Wave 0 addendum PG1): every spec runs in a schema of its own, so that
// the discovery by shape only finds the tables the spec seeded.

const schema = `es_pgmig_${randomUUID().slice(0, 8)}`;
const config = {
	...postgresTestConfig(),
	application_name: 'postgres-migration-spec',
	options: `-c search_path=${schema}`,
};

let admin: Pool;
let db: Pool;

beforeAll(async () => {
	admin = new Pool(postgresTestConfig());
	await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
	db = new Pool(config);
});

afterAll(async () => {
	await db?.end();
	await admin?.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
	await admin?.end();
});

const T0 = Date.UTC(2021, 0, 31, 23, 59, 58, 123);

/**
 * A 3.x corpus with the edge cases of the field: interleaved streams across a month boundary, a stream whose later
 * version has the smaller id (two appends in one millisecond), a gapped stream, a stream that starts at 2, an event id
 * in two streams, a lower-case (non-canonical) event id, and an `occurred_on` that differs from the id's time.
 */
const eventCorpus = (): V1EventRow[] => {
	const row = (streamId: string, version: number, eventId: string, extra: Partial<V1EventRow> = {}): V1EventRow => ({
		stream_id: streamId,
		version,
		event: 'account-credited',
		payload: { amount: version, streamId },
		event_id: eventId,
		aggregate_id: streamId.slice('account-'.length),
		occurred_on: new Date(ulidTime(eventId)).toISOString(),
		...extra,
	});
	return [
		row('account-s1', 1, ulidAt(T0, 'A1'), { correlation_id: 'c-1', causation_id: 'x-1' }),
		row('account-s2', 1, ulidAt(T0 + 1, 'B1')),
		row('account-s1', 2, ulidAt(T0 + 2, 'A2')),
		// February: the event_date changes
		row('account-s2', 2, ulidAt(T0 + 5_000, 'B2'), { occurred_on: '2021-02-01T00:00:03.456Z' }),
		row('account-s1', 3, ulidAt(T0 + 6_000, 'A3')),
		// Inverted: version 2 has the smaller id of the same millisecond
		row('account-s3', 1, ulidAt(T0 + 7_000, 'ZZZZ')),
		row('account-s3', 2, ulidAt(T0 + 7_000, '0001')),
		row('account-s3', 3, ulidAt(T0 + 8_000, 'C3')),
		// Gapped: 1, 2, 3, 5
		row('account-s4', 1, ulidAt(T0 + 9_000, 'D1')),
		row('account-s4', 2, ulidAt(T0 + 9_001, 'D2')),
		row('account-s4', 3, ulidAt(T0 + 9_002, 'D3')),
		row('account-s4', 5, ulidAt(T0 + 9_003, 'D5')),
		// Starts at 2
		row('account-s5', 2, ulidAt(T0 + 10_000, 'E2')),
		row('account-s5', 3, ulidAt(T0 + 10_001, 'E3')),
		// The id of account-s1 version 2, in another stream
		row('account-s6', 1, ulidAt(T0 + 2, 'A2')),
		// Lower case, which 3.x accepted
		row('account-s7', 1, ulidAt(T0 + 11_000, 'G1').toLowerCase()),
	];
};

/**
 * 3.x's order: `ORDER BY event_date, event_id` (with `stream_id, version` as the tiebreak migrate() uses), read from the
 * v1 table with the database's collation.
 */
const legacyOrder = async (table: string): Promise<{ stream_id: string; version: number }[]> =>
	(
		await db.query<{ stream_id: string; version: number }>(
			`SELECT stream_id, version FROM ${escapeIdentifier(table)} ORDER BY event_date, event_id, stream_id, version`,
		)
	).rows;

/**
 * ADR 0001 D33: `r` is the rank in 3.x's order, `key` the running maximum of `r` over the row's stream by version; the
 * positions follow `(key, version)`.
 */
const d33Order = (ranked: readonly { stream_id: string; version: number }[]) => {
	const byStream = new Map<string, { version: number; rank: number }[]>();
	ranked.forEach(({ stream_id, version }, rank) => {
		const rows = byStream.get(stream_id) ?? [];
		rows.push({ version, rank });
		byStream.set(stream_id, rows);
	});
	const keyed: { stream_id: string; version: number; key: number }[] = [];
	for (const [stream_id, rows] of byStream) {
		let key = -1;
		for (const { version, rank } of rows.sort((a, b) => a.version - b.version)) {
			key = Math.max(key, rank);
			keyed.push({ stream_id, version, key });
		}
	}
	return keyed
		.sort((a, b) => a.key - b.key || a.version - b.version)
		.map(({ stream_id, version }) => ({ stream_id, version }));
};

const seedEvents = async (table: string, variant: IndexVariant = '3.0.2', rows = eventCorpus()) => {
	for (const statement of v1EventTableStatements(table, variant)) {
		await db.query(statement);
	}
	await db.query(...v1EventInsert(table, rows));
};

/**
 * A row of a dump: every column but the position, which is a string (or `null` before the migration).
 */
type DumpColumns = { stream_id: string; version: number; [column: string]: unknown };
type DumpRow = DumpColumns & { position: string | null };

/**
 * Everything about a table that a migration may change: its columns, indexes (with the table name replaced), rows and
 * catalog row. Two tables with the same content have the same dump.
 */
const dump = async (table: string, connection: Pool = db) => {
	const oid = (
		await connection.query<{ oid: number | null }>(
			`SELECT to_regclass(format('%I.%I', current_schema(), $1::text))::oid AS oid`,
			[table],
		)
	).rows[0].oid;
	const columns = (
		await connection.query<{ column: string }>(
			`SELECT attname || ' ' || format_type(atttypid, atttypmod) || CASE WHEN attnotnull THEN ' not null' ELSE '' END AS column
			FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
			[oid],
		)
	).rows.map(({ column }) => column);
	const indexes = (
		await connection.query<{ definition: string }>(
			`SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1`,
			[table],
		)
	).rows
		.map(({ definition }) => definition.split(table).join('<t>'))
		.sort();
	const rows = (
		await connection.query<{ row: Record<string, unknown> }>(
			`SELECT to_jsonb(t) AS row
			FROM ${escapeIdentifier(table)} t ORDER BY ${columns.some((column) => column.startsWith('global_position ')) ? 'global_position' : 'stream_id, version'}`,
		)
	).rows.map(({ row: { global_position, ...row } }): DumpRow => ({
		...(row as DumpColumns),
		position: global_position === undefined || global_position === null ? null : String(global_position),
	}));
	const catalog = (
		await connection.query<{ exists: boolean }>(
			`SELECT to_regclass(format('%I.%I', current_schema(), 'event_sourcing_collections')) IS NOT NULL AS exists`,
		)
	).rows[0].exists
		? (
				await connection.query(
					'SELECT kind, schema_version, last_position::text FROM event_sourcing_collections WHERE name = $1',
					[table],
				)
			).rows
		: 'no catalog';
	return { columns, indexes, rows, catalog };
};

const collectionOf = (report: MigrationReport, name: string) => {
	const collection = report.collections.find((candidate) => candidate.name === name);
	if (!collection) {
		throw new Error(`${name} is not in the report: ${report.collections.map(({ name: other }) => other).join(', ')}`);
	}
	return collection;
};

const drain = async <T>(batches: AsyncIterable<T[]>): Promise<T[]> => {
	const items: T[] = [];
	for await (const batch of batches) {
		items.push(...batch);
	}
	return items;
};

describe('PostgresEventStore.migrate', () => {
	const table = EventCollection.get();
	const tenant = EventCollection.get('tenant');
	const bare = EventCollection.get('bare');
	const custom = EventCollection.get('custom');
	let seededDump: Awaited<ReturnType<typeof dump>>;
	let expectedOrder: { stream_id: string; version: number }[];

	beforeAll(async () => {
		await seedEvents(table, '3.0.2');
		await seedEvents(tenant, '3.0.0');
		await seedEvents(bare, 'none');
		await seedEvents(custom, 'custom');
		await db.query(`GRANT SELECT ON ${escapeIdentifier(table)} TO PUBLIC`);
		// A view that doesn't use the changed columns survives the migration
		await db.query(
			`CREATE VIEW ${escapeIdentifier(`${schema}_amounts`)} AS SELECT version, payload FROM ${escapeIdentifier(table)}`,
		);
		seededDump = await dump(table);
		expectedOrder = d33Order(await legacyOrder(table));
	});

	it('should report every 3.x pool and its facts in a dry run, and write nothing', async () => {
		const before = await Promise.all([table, tenant, bare, custom].map((name) => dump(name)));

		const report = await PostgresEventStore.migrate(config, { dryRun: true });

		expect(report.dryRun).toBe(true);
		expect(report.environment.serverVersion).toMatch(/^\d+/);
		expect(report.environment.timeZones.process).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		expect(report.collections.map(({ name }) => name)).toEqual([bare, custom, table, tenant]);

		const events = collectionOf(report, table);
		expect(events).toMatchObject({
			kind: 'events',
			from: 'v1',
			action: 'migrate',
			rows: eventCorpus().length,
			duplicateEventIds: 1,
			nonCrockfordEventIds: 1,
			blocking: [],
			droppedIndexes: [`idx_${table}_event_date_id`],
		});
		expect(events.gappedStreams).toEqual({
			total: 2,
			sample: [
				{ streamId: 'account-s4', events: 4, minVersion: 1, maxVersion: 5 },
				{ streamId: 'account-s5', events: 2, minVersion: 2, maxVersion: 3 },
			],
		});
		expect(events.dependents).toEqual([`view or rule ${schema}_amounts`]);
		expect(events.steps.map(({ name }) => name)).toEqual([
			'create-catalog',
			'migration-lock',
			'begin',
			'lock',
			'number',
			'widen-columns',
			'truncate',
			'drop-event-date',
			'reinsert',
			'index-positions',
			'register',
			'commit',
			'vacuum',
		]);
		expect(events.steps.every(({ status }) => status === 'pending')).toBe(true);
		expect(events.steps.find(({ name }) => name === 'lock')?.statement).toBe(
			'LOCK TABLE "events" IN ACCESS EXCLUSIVE MODE',
		);
		expect(events.warnings.join('\n')).toContain('2 stream(s) have versions');

		expect(collectionOf(report, tenant).droppedIndexes).toEqual(['idx_event_date_id']);
		expect(collectionOf(report, bare).droppedIndexes).toEqual([]);
		expect(collectionOf(report, custom).droppedIndexes).toEqual([`${custom}_custom`]);

		expect(await Promise.all([table, tenant, bare, custom].map((name) => dump(name)))).toEqual(before);
	});

	it('should number the events in 3.x order, keeping every stream in version order, and keep the table', async () => {
		const { rows: before } = await db.query<{ oid: number; relacl: string[] }>(
			`SELECT oid, relacl::text[] AS relacl FROM pg_class WHERE oid = to_regclass($1)`,
			[escapeIdentifier(table)],
		);

		const report = await PostgresEventStore.migrate(config, { pools: [undefined] });

		const events = collectionOf(report, table);
		expect(events.action).toBe('migrate');
		expect(events.steps.every(({ status }) => status === 'done')).toBe(true);

		const migrated = await dump(table);
		expect(migrated.rows.map(({ stream_id, version }) => ({ stream_id, version }))).toEqual(expectedOrder);
		expect(migrated.rows.map(({ position }) => position)).toEqual(expectedOrder.map((_, index) => String(index + 1)));
		// The inverted stream follows its versions, not its ids
		const s3 = migrated.rows.filter(({ stream_id }) => stream_id === 'account-s3');
		expect(s3.map(({ version }) => version)).toEqual([1, 2, 3]);
		for (const stream of new Set(migrated.rows.map(({ stream_id }) => stream_id))) {
			const versions = migrated.rows.filter(({ stream_id }) => stream_id === stream).map(({ version }) => version);
			expect.soft(versions, stream).toEqual([...versions].sort((a, b) => a - b));
		}

		// Every value is kept, occurred_on to the millisecond
		const strip = ({ event_date: _, position: __, ...row }: Record<string, unknown>) => row;
		const byKey = (rows: Record<string, unknown>[]) =>
			rows.map(strip).sort((a, b) => `${a.stream_id}/${a.version}`.localeCompare(`${b.stream_id}/${b.version}`));
		expect(byKey(migrated.rows).map(({ headers, event_version, ...row }) => row)).toEqual(byKey(seededDump.rows));
		expect(migrated.rows.every(({ headers, event_version }) => headers === null && event_version === null)).toBe(true);
		expect(
			migrated.rows.find(({ stream_id, version }) => stream_id === 'account-s2' && version === 2)?.occurred_on,
		).toBe('2021-02-01T00:00:03.456+00:00');

		expect(migrated.columns).toEqual([
			'stream_id text not null',
			'version integer not null',
			'event text not null',
			'payload jsonb not null',
			'event_id text not null',
			'aggregate_id text not null',
			'occurred_on timestamp with time zone not null',
			'correlation_id text',
			'causation_id text',
			'global_position bigint not null',
			'headers jsonb',
			'event_version integer',
		]);
		expect(migrated.indexes).toEqual(
			[
				`CREATE UNIQUE INDEX idx_<t>_global_position ON ${schema}.<t> USING btree (global_position)`,
				`CREATE UNIQUE INDEX <t>_pkey ON ${schema}.<t> USING btree (stream_id, version)`,
			].sort(),
		);
		expect(migrated.catalog).toEqual([
			{ kind: 'events', schema_version: 2, last_position: String(eventCorpus().length) },
		]);

		// The same table: grants and the view survive
		const { rows: after } = await db.query<{ oid: number; relacl: string[] }>(
			`SELECT oid, relacl::text[] AS relacl FROM pg_class WHERE oid = to_regclass($1)`,
			[escapeIdentifier(table)],
		);
		expect(after).toEqual(before);
		const { rows: amounts } = await db.query(
			`SELECT count(*)::int AS count FROM ${escapeIdentifier(`${schema}_amounts`)}`,
		);
		expect(amounts).toEqual([{ count: eventCorpus().length }]);
	});

	it('should skip a migrated table', async () => {
		const report = await PostgresEventStore.migrate(config, { pools: [undefined] });

		expect(collectionOf(report, table)).toMatchObject({ from: 'v2', action: 'skip', steps: [] });
	});

	it('should fence out 3.x writers, and let 4.x continue the positions', async () => {
		await expect(
			db.query(
				...v1EventInsert(table, [
					{
						stream_id: 'account-3x',
						version: 1,
						event: 'account-opened',
						payload: {},
						event_id: ulidAt(Date.now(), 'X'),
						aggregate_id: '3x',
						occurred_on: new Date().toISOString(),
					},
				]),
			),
		).rejects.toMatchObject({ code: '42703' });

		const { store } = createEventStore({ ...config, application_name: 'postgres-migration-spec-store' });
		await store.connect();
		try {
			await expect(store.ensureCollection()).resolves.toBe(table);
			const stream = EventStream.for(Account, AccountId.generate());
			const appended = await store.appendEvents(stream, getEvents().slice(0, 2), {
				expectedVersion: ExpectedVersion.NoStream,
			});
			const n = BigInt(eventCorpus().length);
			expect(appended.map(({ metadata }) => metadata.globalPosition)).toEqual([n + 1n, n + 2n]);

			const read = await drain(store.readAll());
			expect(read.map(({ metadata }) => metadata.globalPosition)).toEqual(read.map((_, index) => BigInt(index + 1)));
			const lower = read.find(({ metadata }) => metadata.eventId.value === ulidAt(T0 + 11_000, 'G1').toLowerCase());
			expect(lower?.metadata.version).toBe(1);

			// The gapped stream conflicts on its next append at the version it would have had
			const gapped = { streamId: 'account-s4', aggregateId: 's4' } as unknown as EventStream;
			await expect(store.appendEvents(gapped, getEvents().slice(0, 1), { expectedVersion: 4 })).rejects.toMatchObject({
				expectedVersion: 4,
				actualVersion: 5,
			});
		} finally {
			await store.disconnect();
		}
	});

	it('should migrate the other index variants the same way', async () => {
		const report = await PostgresEventStore.migrate(config, { pools: ['tenant', 'bare', 'custom'] });

		for (const collection of [tenant, bare, custom]) {
			expect(collectionOf(report, collection).action).toBe('migrate');
			const migrated = await dump(collection);
			expect(migrated.rows.map(({ stream_id, version }) => ({ stream_id, version }))).toEqual(expectedOrder);
			expect(migrated.indexes).toEqual(
				[
					`CREATE UNIQUE INDEX "idx_<t>_global_position" ON ${schema}."<t>" USING btree (global_position)`,
					`CREATE UNIQUE INDEX "<t>_pkey" ON ${schema}."<t>" USING btree (stream_id, version)`,
				].sort(),
			);
		}
		// The 3.0.0 name is schema-wide: dropping the event_date column dropped it
		const { rows } = await db.query(
			`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_event_date_id'`,
			[schema],
		);
		expect(rows).toEqual([]);
	});

	it('should report the triggers, publications and objects on event_date, and keep the columns a user added', async () => {
		const decorated = EventCollection.get('decorated');
		await seedEvents(decorated);
		const t = escapeIdentifier(decorated);
		const fn = escapeIdentifier(`${schema}_audit`);
		const publication = escapeIdentifier(`${schema}_cdc`);
		await db.query(`ALTER TABLE ${t} ADD COLUMN tenant TEXT, ADD COLUMN "order" INT`);
		await db.query(`UPDATE ${t} SET tenant = 'tenant-' || stream_id, "order" = version * 10`);
		await db.query(`ALTER TABLE ${t} ADD CONSTRAINT dated CHECK (event_date <> event_id)`);
		await db.query(`CREATE INDEX ${escapeIdentifier(`${decorated}_month`)} ON ${t} ((lower(event_date)))`);
		await db.query(
			`CREATE INDEX ${escapeIdentifier(`${decorated}_recent`)} ON ${t} (version) WHERE event_date > '2000-01'`,
		);
		await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
		await db.query(`CREATE TRIGGER audit BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
		await db.query(`CREATE TRIGGER emptied AFTER TRUNCATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`);
		await db.query(`CREATE PUBLICATION ${publication} FOR TABLE ${t}`);
		const before = await dump(decorated);

		try {
			const dryRun = collectionOf(
				await PostgresEventStore.migrate(config, { pools: ['decorated'], dryRun: true }),
				decorated,
			);

			expect(dryRun).toMatchObject({ action: 'migrate', blocking: [] });
			expect(dryRun.dependents).toEqual([
				'trigger audit (INSERT)',
				'trigger emptied (TRUNCATE)',
				`publication ${schema}_cdc`,
			]);
			expect(dryRun.droppedIndexes).toEqual([
				`${decorated}_month`,
				`${decorated}_recent`,
				`idx_${decorated}_event_date_id`,
			]);
			expect(dryRun.warnings).toEqual(
				expect.arrayContaining([
					expect.stringMatching(/^The migration drops constraint dated on table .*, which uses event_date\.$/),
					`The publication ${schema}_cdc receives a TRUNCATE of ${decorated} followed by an INSERT of every row.`,
					expect.stringContaining('The trigger audit fires'),
					expect.stringContaining('The trigger emptied fires'),
				]),
			);
			expect(await dump(decorated)).toEqual(before);

			const report = await PostgresEventStore.migrate(config, { pools: ['decorated'] });

			expect(collectionOf(report, decorated).action).toBe('migrate');
			const migrated = await dump(decorated);
			expect(migrated.rows.map(({ stream_id, version }) => ({ stream_id, version }))).toEqual(expectedOrder);
			// The added columns keep their values, and come before the v2 columns that the migration added
			expect(
				migrated.rows.every(
					({ stream_id, version, tenant, order }) => tenant === `tenant-${stream_id}` && order === version * 10,
				),
			).toBe(true);
			expect(migrated.columns.slice(9, 11)).toEqual(['tenant text', 'order integer']);
			const { rows: publications } = await db.query(
				'SELECT pubname FROM pg_publication_tables WHERE schemaname = current_schema() AND tablename = $1',
				[decorated],
			);
			expect(publications).toEqual([{ pubname: `${schema}_cdc` }]);
		} finally {
			await db.query(`DROP PUBLICATION IF EXISTS ${publication}`);
		}
	});

	it('should block the table of a pool whose name PostgreSQL truncated, and find it without a pool', async () => {
		const long = 'p'.repeat(60);
		const truncated = `${long}-ev`;
		// 3.x created it with the long name, which PostgreSQL truncated to 63 bytes
		for (const statement of v1EventTableStatements(EventCollection.get(long), 'none')) {
			await db.query(statement);
		}
		await db.query(...v1EventInsert(truncated, eventCorpus()));
		const before = await dump(truncated);

		const explicit = await PostgresEventStore.migrate(config, { pools: [long] });
		expect(collectionOf(explicit, EventCollection.get(long))).toMatchObject({
			from: 'v1',
			action: 'blocked',
			blocking: [expect.stringContaining('is 67 bytes long')],
			steps: [],
		});
		const discovered = await PostgresEventStore.migrate(config, { dryRun: true });
		expect(collectionOf(discovered, truncated)).toMatchObject({
			action: 'blocked',
			blocking: [expect.stringContaining('a pool name of at most 56 bytes')],
		});
		expect(await dump(truncated)).toEqual(before);
		await db.query(`DROP TABLE ${escapeIdentifier(truncated)}`);
	});

	it('should leave the rows in place when the steps run one by one outside a transaction, and resume', async () => {
		const autocommit = EventCollection.get('autocommit');
		await seedEvents(autocommit);
		const { steps } = collectionOf(
			await PostgresEventStore.migrate(config, { pools: ['autocommit'], dryRun: true }),
			autocommit,
		);
		const statementOf = (name: string) => steps.find((step) => step.name === name)?.statement ?? '';

		// A tool that commits every statement: the numbered copy is dropped at the end of its own statement
		await db.query(statementOf('number'));
		await db.query(statementOf('widen-columns'));
		await expect(db.query(statementOf('truncate'))).rejects.toThrow(/The numbered copy es_migrate_\w+ is missing/);
		expect((await dump(autocommit)).rows).toHaveLength(eventCorpus().length);

		const report = await PostgresEventStore.migrate(config, { pools: ['autocommit'] });
		expect(collectionOf(report, autocommit)).toMatchObject({ from: 'v1-partial', action: 'resume' });
		expect((await dump(autocommit)).rows.map(({ stream_id, version }) => ({ stream_id, version }))).toEqual(
			expectedOrder,
		);
	});

	it('should inspect and vacuum without the timeouts of the role or the pool config, and restore them', async () => {
		const timed = EventCollection.get('timed');
		await seedEvents(timed);
		const statements: string[] = [];
		const query = Client.prototype.query;
		vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
			statements.push(typeof args[0] === 'string' ? args[0] : '');
			return query.apply(this, args);
		} as never);

		const timeouts = { options: `-c search_path=${schema} -c statement_timeout=20`, query_timeout: 1 };
		const report = await PostgresEventStore.migrate({ ...config, ...timeouts }, { pools: ['timed'] });

		expect(collectionOf(report, timed)).toMatchObject({ action: 'migrate', warnings: expect.any(Array) });
		expect(collectionOf(report, timed).steps.every(({ status }) => status === 'done')).toBe(true);
		expect(statements[0]).toBe("SET statement_timeout = 0; SET work_mem = '64MB'");
		expect(statements.at(-1)).toBe('RESET statement_timeout; RESET work_mem');

		// On a connected store, the connection goes back to its pool with the pool's settings
		const { store } = createEventStore({
			...config,
			options: `-c search_path=${schema} -c statement_timeout=20000`,
			max: 1,
			application_name: 'postgres-migration-spec-store',
		});
		await store.connect();
		try {
			await store.migrate({ pools: ['timed'], dryRun: true });
			const { rows } = await store['pool']!.query('SHOW statement_timeout');
			expect(rows).toEqual([{ statement_timeout: '20s' }]);
		} finally {
			await store.disconnect();
		}
	});

	it('should warn when VACUUM fails after the commit, and still report the migration', async () => {
		const vacuumed = EventCollection.get('vacuumed');
		await seedEvents(vacuumed);
		const query = Client.prototype.query;
		vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
			if (typeof args[0] === 'string' && args[0].startsWith('VACUUM')) {
				const error = new DatabaseError('could not resize shared memory segment', 0, 'error');
				error.severity = 'ERROR';
				error.code = '53100';
				return Promise.reject(error);
			}
			return query.apply(this, args);
		} as never);

		const report = await PostgresEventStore.migrate(config, { pools: ['vacuumed'] });

		const collection = collectionOf(report, vacuumed);
		expect(collection.action).toBe('migrate');
		expect(collection.steps.find(({ name }) => name === 'vacuum')?.status).toBe('skipped');
		expect(collection.steps.filter(({ name }) => name !== 'vacuum').every(({ status }) => status === 'done')).toBe(
			true,
		);
		expect(collection.warnings).toEqual(
			expect.arrayContaining([
				`VACUUM failed after the migration committed (could not resize shared memory segment): run it by hand: VACUUM (ANALYZE, PARALLEL 0) ${escapeIdentifier(vacuumed)};`,
			]),
		);
		expect((await dump(vacuumed)).catalog).toEqual([
			{ kind: 'events', schema_version: 2, last_position: String(eventCorpus().length) },
		]);
	});

	describe('blocked', () => {
		it('should not migrate a table with a view on event_date', async () => {
			const viewed = EventCollection.get('viewed');
			await seedEvents(viewed);
			const view = `${schema}_dates`;
			await db.query(`CREATE VIEW ${escapeIdentifier(view)} AS SELECT event_date FROM ${escapeIdentifier(viewed)}`);
			const before = await dump(viewed);

			const report = await PostgresEventStore.migrate(config, { pools: ['viewed'] });

			const collection = collectionOf(report, viewed);
			expect(collection.action).toBe('blocked');
			expect(collection.blocking.join('\n')).toContain(`${view} uses event_date`);
			expect(collection.steps.every(({ status }) => status === 'skipped')).toBe(true);
			expect(await dump(viewed)).toEqual(before);
		});

		it('should not migrate for a role that may not write the catalog, and say so in a dry run', async () => {
			const owned = EventCollection.get('owned');
			await seedEvents(owned);
			const role = `es_pgmig_${randomUUID().slice(0, 8)}`;
			const password = randomUUID();
			const r = escapeIdentifier(role);
			await admin.query(`CREATE ROLE ${r} LOGIN PASSWORD ${escapeLiteral(password)}`);
			try {
				await admin.query(`GRANT USAGE, CREATE ON SCHEMA ${escapeIdentifier(schema)} TO ${r}`);
				await db.query(`ALTER TABLE ${escapeIdentifier(owned)} OWNER TO ${r}`);
				await db.query(catalogStatement());
				await db.query(`GRANT SELECT ON event_sourcing_collections TO ${r}`);
				const asRole = { ...config, user: role, password };

				for (const grants of ['SELECT only', 'nothing']) {
					const report = await PostgresEventStore.migrate(asRole, { pools: ['owned'] });

					const collection = collectionOf(report, owned);
					expect.soft(collection.action, grants).toBe('blocked');
					expect(collection.blocking).toEqual([
						'The current role may not read and write the event_sourcing_collections catalog: grant it SELECT, INSERT and UPDATE on the catalog.',
					]);
					expect((await dump(owned)).columns).toContain('event_date character varying(7) not null');
					await db.query(`REVOKE SELECT ON event_sourcing_collections FROM ${r}`);
				}
			} finally {
				await db.query(`DROP TABLE IF EXISTS ${escapeIdentifier(owned)}`);
				await admin.query(`DROP OWNED BY ${r}`);
				await admin.query(`DROP ROLE ${r}`);
			}
		});

		it('should not migrate a table that other tables reference', async () => {
			const referenced = EventCollection.get('referenced');
			await seedEvents(referenced);
			await db.query(
				`CREATE TABLE ${escapeIdentifier(`${schema}_refs`)} (stream_id VARCHAR(120), version INT,
				FOREIGN KEY (stream_id, version) REFERENCES ${escapeIdentifier(referenced)} (stream_id, version))`,
			);

			const report = await PostgresEventStore.migrate(config, { pools: ['referenced'], dryRun: true });

			expect(collectionOf(report, referenced).action).toBe('blocked');
			expect(collectionOf(report, referenced).blocking.join('\n')).toContain('foreign keys');
		});

		it('should report a table that sessions still use as blocked, and migrate it once they stopped', async () => {
			const busy = EventCollection.get('busy');
			await seedEvents(busy);
			const session = new Client(config);
			await session.connect();
			try {
				await session.query('BEGIN');
				await session.query(`SELECT count(*) FROM ${escapeIdentifier(busy)}`);

				const report = await PostgresEventStore.migrate(config, { pools: ['busy'], lockTimeoutMs: 200 });

				const collection = collectionOf(report, busy);
				expect(collection.action).toBe('blocked');
				expect(collection.blocking.join('\n')).toContain('Other sessions still use the table');
				expect((await dump(busy)).columns).toContain('event_date character varying(7) not null');
				await session.query('ROLLBACK');

				const retry = await PostgresEventStore.migrate(config, { pools: ['busy'] });
				expect(collectionOf(retry, busy).action).toBe('migrate');
			} finally {
				await session.end();
			}
		});

		it('should report a table that another migration is migrating as blocked, but not its namesake in another schema', async () => {
			const locked = EventCollection.get('locked');
			await seedEvents(locked);
			const other = new Client(config);
			await other.connect();
			const elsewhere = `es_pgmig_lock_${randomUUID().slice(0, 8)}`;
			await admin.query(`CREATE SCHEMA ${escapeIdentifier(elsewhere)}`);
			const elsewhereConfig = { ...config, options: `-c search_path=${elsewhere}` };
			try {
				await other.query(`SELECT pg_advisory_lock(${migrationLockKey(locked)})`);

				const report = await PostgresEventStore.migrate(config, { pools: ['locked'] });

				expect(collectionOf(report, locked)).toMatchObject({
					action: 'blocked',
					blocking: ['Another migration of this table is running.'],
				});

				// Advisory locks are per database: the key names the schema
				const namesake = new Pool(elsewhereConfig);
				try {
					for (const statement of v1EventTableStatements(locked)) {
						await namesake.query(statement);
					}
					await namesake.query(...v1EventInsert(locked, eventCorpus()));
				} finally {
					await namesake.end();
				}
				const parallel = await PostgresEventStore.migrate(elsewhereConfig, { pools: ['locked'] });
				expect(collectionOf(parallel, locked).action).toBe('migrate');
			} finally {
				await other.end();
				await admin.query(`DROP SCHEMA ${escapeIdentifier(elsewhere)} CASCADE`);
			}
		});

		it('should report a table that changed while the migration waited for its lock as blocked', async () => {
			const changing = EventCollection.get('changing');
			await seedEvents(changing);

			const report = await runMigration(db, 'events', { pools: ['changing'] }, undefined, {
				onStepComplete: async (_, step) => {
					if (step === 'begin') {
						await db.query(`ALTER TABLE ${escapeIdentifier(changing)} ADD COLUMN global_position BIGINT`);
					}
				},
			});

			const collection = collectionOf(report, changing);
			expect(collection).toMatchObject({
				from: 'v1',
				action: 'blocked',
				blocking: [expect.stringContaining('The table changed from v1 to v1-partial')],
			});
			expect(collection.steps.map(({ name, status }) => [name, status])).toEqual([
				['migration-lock', 'done'],
				['begin', 'done'],
				...collection.steps.slice(2).map(({ name }) => [name, 'skipped']),
			]);
			const { columns } = await dump(changing);
			expect(columns).toEqual(
				expect.arrayContaining(['event_date character varying(7) not null', 'global_position bigint']),
			);
			// The session lock was released
			const { rows } = await db.query(`SELECT pg_try_advisory_lock(${migrationLockKey(changing)}) AS locked`);
			expect(rows).toEqual([{ locked: true }]);
			await db.query('SELECT pg_advisory_unlock_all()');
		});

		it('should block on the objects that keep event_date or a widened column, and name them in a dry run', async () => {
			const guarded = EventCollection.get('guarded');
			await seedEvents(guarded);
			const t = escapeIdentifier(guarded);
			await db.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
			await db.query(`CREATE POLICY recent ON ${t} USING (event_date >= '2000-01')`);
			await db.query(`ALTER TABLE ${t} ADD COLUMN month TEXT GENERATED ALWAYS AS (event_date || '-01') STORED`);
			await db.query(
				`CREATE FUNCTION ${escapeIdentifier(`${schema}_noop`)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
			);
			await db.query(
				`CREATE TRIGGER renamed BEFORE UPDATE OF stream_id ON ${t} FOR EACH ROW EXECUTE FUNCTION ${escapeIdentifier(`${schema}_noop`)}()`,
			);

			const report = await PostgresEventStore.migrate(config, { pools: ['guarded'], dryRun: true });

			const collection = collectionOf(report, guarded);
			expect(collection.action).toBe('blocked');
			expect(collection.blocking).toEqual([
				expect.stringMatching(/^The column month of table .* uses event_date, which the migration drops/),
				expect.stringMatching(/^The policy recent on table .* uses event_date, which the migration drops/),
				expect.stringMatching(/^The trigger renamed on table .* uses stream_id, which the migration converts/),
			]);
		});

		it('should not migrate a partly migrated table without event_date', async () => {
			const partial = EventCollection.get('partial');
			await seedEvents(partial);
			await db.query(
				`ALTER TABLE ${escapeIdentifier(partial)} ADD COLUMN global_position BIGINT, DROP COLUMN event_date`,
			);

			const report = await PostgresEventStore.migrate(config, { pools: ['partial'] });

			expect(collectionOf(report, partial)).toMatchObject({ from: 'v1-partial', action: 'blocked' });
		});

		it('should resume a partly migrated table that still has event_date', async () => {
			const resumed = EventCollection.get('resumed');
			await seedEvents(resumed);
			await db.query(
				`ALTER TABLE ${escapeIdentifier(resumed)} ADD COLUMN global_position BIGINT, ADD COLUMN headers JSONB`,
			);

			const report = await PostgresEventStore.migrate(config, { pools: ['resumed'] });

			expect(collectionOf(report, resumed)).toMatchObject({ from: 'v1-partial', action: 'resume' });
			expect((await dump(resumed)).rows.map(({ stream_id, version }) => ({ stream_id, version }))).toEqual(
				expectedOrder,
			);
		});

		it('should register an unregistered v2 table, and skip an absent one', async () => {
			const { store } = createEventStore({ ...config, application_name: 'postgres-migration-spec-store' });
			await store.connect();
			try {
				const collection = await store.ensureCollection('registered');
				await store.appendEvents(EventStream.for(Account, AccountId.generate()), getEvents().slice(0, 3), {
					expectedVersion: 0,
					pool: 'registered',
				});
				await db.query('DELETE FROM event_sourcing_collections WHERE name = $1', [collection]);

				const report = await PostgresEventStore.migrate(config, { pools: ['registered', 'absent'] });

				expect(collectionOf(report, collection)).toMatchObject({ from: 'v2', action: 'resume' });
				expect(collectionOf(report, collection).steps.map(({ name, status }) => [name, status])).toEqual([
					['register', 'done'],
				]);
				expect(collectionOf(report, EventCollection.get('absent'))).toMatchObject({ from: 'absent', action: 'skip' });
				expect((await dump(collection)).catalog).toEqual([{ kind: 'events', schema_version: 2, last_position: '3' }]);
			} finally {
				await store.disconnect();
			}
		});
	});

	describe('crash injection', () => {
		const steps = [
			'migration-lock',
			'begin',
			'lock',
			'number',
			'widen-columns',
			'truncate',
			'drop-event-date',
			'reinsert',
			'index-positions',
			'register',
			'commit',
			'vacuum',
		];
		let clean: Awaited<ReturnType<typeof dump>>;

		beforeAll(async () => {
			await seedEvents(EventCollection.get('clean'));
			await PostgresEventStore.migrate(config, { pools: ['clean'] });
			clean = await dump(EventCollection.get('clean'));
		});

		it.each(steps)('should end like a clean run when a migration stops after %s', async (step) => {
			const pool = `crash-${step}`;
			const crashed = EventCollection.get(pool);
			await seedEvents(crashed);
			const seeded = await dump(crashed);
			const crash = new Error(`crash after ${step}`);

			await expect(
				runMigration(db, 'events', { pools: [pool] }, undefined, {
					onStepComplete: (_, completed) => {
						if (completed === step) {
							throw crash;
						}
					},
				}),
			).rejects.toBe(crash);

			const afterCrash = await dump(crashed);
			const committed = steps.indexOf(step) >= steps.indexOf('commit');
			if (committed) {
				expect(afterCrash.catalog).toEqual([
					{ kind: 'events', schema_version: 2, last_position: String(eventCorpus().length) },
				]);
			} else {
				expect(afterCrash).toEqual(seeded);
			}

			const rerun = await runMigration(db, 'events', { pools: [pool] });
			expect(collectionOf(rerun, crashed).action).toBe(committed ? 'skip' : 'migrate');
			const final = await dump(crashed);
			expect({ ...final, indexes: final.indexes.map((index) => index.replaceAll(`"<t>"`, '<t>')) }).toEqual({
				...clean,
				indexes: clean.indexes.map((index) => index.replaceAll(`"<t>"`, '<t>')),
			});

			// The session lock was released
			const { rows } = await db.query(`SELECT pg_try_advisory_lock(${migrationLockKey(crashed)}) AS locked`);
			expect(rows).toEqual([{ locked: true }]);
			await db.query(`SELECT pg_advisory_unlock_all()`);
		});

		it('should end like a clean run when a migration stops after creating the catalog', async () => {
			const own = `es_pgmig_catalog_${randomUUID().slice(0, 8)}`;
			await admin.query(`CREATE SCHEMA ${escapeIdentifier(own)}`);
			const ownPool = new Pool({ ...config, options: `-c search_path=${own}` });
			try {
				for (const statement of v1EventTableStatements('events')) {
					await ownPool.query(statement);
				}
				await ownPool.query(...v1EventInsert('events', eventCorpus()));
				const crash = new Error('crash after create-catalog');

				await expect(
					runMigration(ownPool, 'events', {}, undefined, {
						onStepComplete: (_, completed) => {
							if (completed === 'create-catalog') {
								throw crash;
							}
						},
					}),
				).rejects.toBe(crash);
				const { rows: catalog } = await ownPool.query(`SELECT count(*)::int AS rows FROM event_sourcing_collections`);
				expect(catalog).toEqual([{ rows: 0 }]);

				const rerun = await runMigration(ownPool, 'events', {});
				expect(collectionOf(rerun, 'events').steps.map(({ name }) => name)).not.toContain('create-catalog');
				const { rows } = await ownPool.query('SELECT stream_id, version FROM events ORDER BY global_position');
				expect(rows).toEqual(expectedOrder);
			} finally {
				await ownPool.end();
				await admin.query(`DROP SCHEMA ${escapeIdentifier(own)} CASCADE`);
			}
		});
	});

	it('should migrate on a connected store too', async () => {
		const connected = EventCollection.get('connected');
		await seedEvents(connected);
		const { store } = createEventStore({ ...config, application_name: 'postgres-migration-spec-store' });
		await store.connect();
		try {
			const progress: string[] = [];
			const report = await store.migrate({ pools: ['connected'], onProgress: ({ step }) => progress.push(step) });

			expect(collectionOf(report, connected).action).toBe('migrate');
			expect(progress).toEqual(collectionOf(report, connected).steps.map(({ name }) => name));
			await expect(store.ensureCollection('connected')).resolves.toBe(connected);
		} finally {
			await store.disconnect();
		}
	});

	it('should reject an invalid lock timeout before touching anything', async () => {
		await expect(PostgresEventStore.migrate(config, { lockTimeoutMs: 0 })).rejects.toThrow(RangeError);
	});
});

describe('PostgresSnapshotStore.migrate', () => {
	const table = SnapshotCollection.get();
	const tenant = SnapshotCollection.get('tenant');
	const custom = SnapshotCollection.get('custom');

	const row = (
		streamId: string,
		version: number,
		registeredOn: string,
		latest: boolean,
		aggregateName = 'account',
	): V1SnapshotRow => ({
		stream_id: streamId,
		version,
		payload: { balance: version },
		snapshot_id: `snapshot-${streamId}-${version}`,
		aggregate_id: streamId.slice(streamId.indexOf('-') + 1),
		registered_on: registeredOn,
		aggregate_name: aggregateName,
		latest: latest ? `latest#${streamId}` : null,
	});

	/**
	 * Written in Brussels: a winter time (UTC+1) and a summer time (UTC+2), and the flag damage of the field.
	 */
	const snapshotCorpus = (): V1SnapshotRow[] => [
		row('account-a1', 1, '2024-03-10 12:00:00.123', false),
		row('account-a1', 2, '2024-07-01 12:00:00.456', true),
		// Two flags
		row('account-a2', 1, '2024-01-01 00:30:00', true),
		row('account-a2', 2, '2024-01-01 00:31:00', true),
		// No flag
		row('account-a3', 1, '2024-01-02 10:00:00', false),
		// The flag on a lower version
		row('account-a4', 1, '2024-01-03 10:00:00', true),
		row('account-a4', 2, '2024-01-03 11:00:00', false),
		row('account-B5', 1, '2024-01-04 10:00:00', true),
	];

	const seedSnapshots = async (collection: string, variant: IndexVariant = '3.0.2') => {
		for (const statement of v1SnapshotTableStatements(collection, variant)) {
			await db.query(statement);
		}
		await db.query(...v1SnapshotInsert(collection, snapshotCorpus()));
	};

	const flags = async (collection: string) =>
		(
			await db.query<{ stream_id: string; version: number }>(
				`SELECT stream_id, version FROM ${escapeIdentifier(collection)} WHERE latest IS NOT NULL ORDER BY stream_id COLLATE "C"`,
			)
		).rows;

	beforeAll(async () => {
		await seedSnapshots(table, '3.0.2');
		await seedSnapshots(tenant, '3.0.0');
		await seedSnapshots(custom, 'custom');
	});

	it('should report the flags and the conversion in a dry run, and write nothing', async () => {
		const before = await Promise.all([table, tenant, custom].map((name) => dump(name)));

		const report = await PostgresSnapshotStore.migrate(config, { dryRun: true, legacyTimeZone: 'Europe/Brussels' });

		const snapshots = collectionOf(report, table);
		expect(snapshots).toMatchObject({
			kind: 'snapshots',
			from: 'v1',
			action: 'migrate',
			rows: snapshotCorpus().length,
			snapshotFlags: { duplicateLatest: 1, missingLatest: 2 },
			droppedIndexes: [`idx_${table}_aggregate_name_latest`],
			blocking: [],
		});
		expect(snapshots.steps.find(({ name }) => name === 'convert-columns')?.statement).toContain(
			"ALTER COLUMN registered_on TYPE TIMESTAMPTZ USING registered_on AT TIME ZONE 'Europe/Brussels'",
		);
		expect(collectionOf(report, tenant).droppedIndexes).toEqual(['idx_aggregate_name_latest']);
		expect(collectionOf(report, custom).droppedIndexes).toEqual([`${custom}_custom`]);
		expect(await Promise.all([table, tenant, custom].map((name) => dump(name)))).toEqual(before);
	});

	it("should reject a time zone the server doesn't know", async () => {
		await expect(PostgresSnapshotStore.migrate(config, { legacyTimeZone: 'Mars/Olympus_Mons' })).rejects.toThrow(
			RangeError,
		);
	});

	it('should convert the wall times, flag the highest version of every stream and enforce one flag', async () => {
		const seeded = await dump(table);
		const report = await PostgresSnapshotStore.migrate(config, {
			pools: [undefined],
			legacyTimeZone: 'Europe/Brussels',
		});

		expect(collectionOf(report, table).action).toBe('migrate');
		// Every value but the flags and the times is kept, row by row
		const values = (rows: DumpRow[]) =>
			rows
				.map(({ latest: _, registered_on: __, position: ___, ...row }) => row)
				.sort((a, b) => `${a.stream_id}/${a.version}`.localeCompare(`${b.stream_id}/${b.version}`));
		expect(values((await dump(table)).rows)).toEqual(values(seeded.rows));
		expect((await dump(table)).rows).toHaveLength(snapshotCorpus().length);
		const { rows } = await db.query<{ stream_id: string; version: number; registered_on: Date }>(
			`SELECT stream_id, version, registered_on FROM ${escapeIdentifier(table)} WHERE stream_id = 'account-a1' ORDER BY version`,
		);
		expect(rows.map(({ registered_on }) => registered_on.toISOString())).toEqual([
			'2024-03-10T11:00:00.123Z',
			'2024-07-01T10:00:00.456Z',
		]);
		expect(await flags(table)).toEqual([
			{ stream_id: 'account-B5', version: 1 },
			{ stream_id: 'account-a1', version: 2 },
			{ stream_id: 'account-a2', version: 2 },
			{ stream_id: 'account-a3', version: 1 },
			{ stream_id: 'account-a4', version: 2 },
		]);
		const migrated = await dump(table);
		expect(migrated.columns).toEqual([
			'stream_id text not null',
			'version integer not null',
			'payload jsonb not null',
			'snapshot_id text not null',
			'aggregate_id text not null',
			'registered_on timestamp with time zone not null',
			'aggregate_name text not null',
			'latest text',
		]);
		expect(migrated.indexes).toEqual(
			[
				`CREATE UNIQUE INDEX idx_<t>_latest ON ${schema}.<t> USING btree (aggregate_name, latest) WHERE (latest IS NOT NULL)`,
				`CREATE UNIQUE INDEX <t>_pkey ON ${schema}.<t> USING btree (stream_id, version)`,
			].sort(),
		);
		expect(migrated.catalog).toEqual([{ kind: 'snapshots', schema_version: 2, last_position: '0' }]);

		const second = await PostgresSnapshotStore.migrate(config, { pools: [undefined] });
		expect(collectionOf(second, table)).toMatchObject({ from: 'v2', action: 'skip' });
	});

	it('should hand the store a table it uses without warning, with a binary aggregate cursor', async () => {
		const store = createSnapshotStore({ ...config, application_name: 'postgres-migration-spec-store' });
		const warn = vi.spyOn(store['logger'], 'warn');
		await store.connect();
		try {
			await store.ensureCollection();
			expect(warn).not.toHaveBeenCalled();

			const latest = await drain(store.getLastEnvelopesForAggregate(Account));
			expect(latest.map(({ metadata }) => `${metadata.aggregateId}@${metadata.version}`)).toEqual([
				'a4@2',
				'a3@1',
				'a2@2',
				'a1@2',
				'B5@1',
			]);
			const stream = { streamId: 'account-a3', aggregateId: 'a3', aggregate: 'account' } as SnapshotStream;
			await expect(store.getLastEnvelope(stream)).resolves.toMatchObject({ metadata: { version: 1 } });
		} finally {
			await store.disconnect();
		}
	});

	it('should convert UTC wall times without rewriting the table', async () => {
		const { rows: before } = await db.query<{ relfilenode: number }>(
			'SELECT relfilenode FROM pg_class WHERE oid = to_regclass($1)',
			[escapeIdentifier(tenant)],
		);

		const report = await PostgresSnapshotStore.migrate(config, { pools: ['tenant', 'custom'], legacyTimeZone: 'UTC' });

		expect(collectionOf(report, tenant).steps.find(({ name }) => name === 'convert-columns')?.statement).toMatch(
			/^SET LOCAL TimeZone = 'UTC'; ALTER TABLE .*ALTER COLUMN registered_on TYPE TIMESTAMPTZ$/,
		);
		const { rows: after } = await db.query<{ relfilenode: number }>(
			'SELECT relfilenode FROM pg_class WHERE oid = to_regclass($1)',
			[escapeIdentifier(tenant)],
		);
		expect(after).toEqual(before);
		const { rows } = await db.query<{ registered_on: Date }>(
			`SELECT registered_on FROM ${escapeIdentifier(tenant)} WHERE stream_id = 'account-a1' ORDER BY version`,
		);
		expect(rows.map(({ registered_on }) => registered_on.toISOString())).toEqual([
			'2024-03-10T12:00:00.123Z',
			'2024-07-01T12:00:00.456Z',
		]);
		expect(await flags(custom)).toHaveLength(5);
	});

	it('should migrate on a connected store too', async () => {
		const connected = SnapshotCollection.get('connected');
		await seedSnapshots(connected);
		const store = createSnapshotStore({ ...config, application_name: 'postgres-migration-spec-store' });
		await store.connect();
		try {
			const report = await store.migrate({ pools: ['connected'], legacyTimeZone: 'UTC' });

			expect(collectionOf(report, connected)).toMatchObject({ from: 'v1', action: 'migrate' });
			expect(await flags(connected)).toHaveLength(5);
		} finally {
			await store.disconnect();
		}
	});

	it('should keep the instant of a snapshot that 4.x appended to a 3.x table, read in the process time zone', async () => {
		const zone = process.env.TZ;
		process.env.TZ = 'Europe/Brussels';
		const dated = SnapshotCollection.get('dated');
		const store = createSnapshotStore({ ...config, application_name: 'postgres-migration-spec-store' });
		try {
			await seedSnapshots(dated);
			await store.connect();
			vi.spyOn(store['logger'], 'warn').mockImplementation(() => undefined);
			await store.ensureCollection('dated');
			const stream = { streamId: 'account-a1', aggregateId: 'a1', aggregate: 'account' } as SnapshotStream;
			const appended = await store.appendSnapshot(stream, 3, { balance: 3 } as never, 'dated');

			// legacyTimeZone defaults to the time zone of the process, which is the one the 4.x store wrote in
			const report = await PostgresSnapshotStore.migrate(config, { pools: ['dated'] });

			expect(report.environment.timeZones.process).toBe('Europe/Brussels');
			expect(collectionOf(report, dated).action).toBe('migrate');
			const last = await store.getLastEnvelope(stream, 'dated');
			expect(last?.metadata.registeredOn.toISOString()).toBe(appended.metadata.registeredOn.toISOString());
		} finally {
			await store.disconnect();
			if (zone === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = zone;
			}
		}
	});

	describe('crash injection', () => {
		const steps = [
			'migration-lock',
			'begin',
			'lock',
			'drop-legacy-indexes',
			'unflag',
			'flag',
			'convert-columns',
			'index-latest',
			'register',
			'commit',
			'vacuum',
		];
		let clean: Awaited<ReturnType<typeof dump>>;

		beforeAll(async () => {
			await seedSnapshots(SnapshotCollection.get('clean'));
			await PostgresSnapshotStore.migrate(config, { pools: ['clean'], legacyTimeZone: 'Europe/Brussels' });
			clean = await dump(SnapshotCollection.get('clean'));
		});

		it.each(steps)('should end like a clean run when a migration stops after %s', async (step) => {
			const pool = `crash-${step}`;
			const crashed = SnapshotCollection.get(pool);
			await seedSnapshots(crashed);
			const seeded = await dump(crashed);
			const crash = new Error(`crash after ${step}`);
			const options = { pools: [pool], legacyTimeZone: 'Europe/Brussels' };

			await expect(
				runMigration(db, 'snapshots', options, undefined, {
					onStepComplete: (_, completed) => {
						if (completed === step) {
							throw crash;
						}
					},
				}),
			).rejects.toBe(crash);
			const committed = steps.indexOf(step) >= steps.indexOf('commit');
			if (committed) {
				expect((await dump(crashed)).catalog).toEqual([{ kind: 'snapshots', schema_version: 2, last_position: '0' }]);
			} else {
				expect(await dump(crashed)).toEqual(seeded);
			}

			const rerun = await runMigration(db, 'snapshots', options);
			expect(collectionOf(rerun, crashed).action).toBe(committed ? 'skip' : 'migrate');
			const final = await dump(crashed);
			const normalize = (dumped: typeof final) => ({
				...dumped,
				indexes: dumped.indexes.map((index) => index.replaceAll('"<t>"', '<t>')),
				rows: dumped.rows.map(({ snapshot_id, ...rest }) => ({
					...rest,
					snapshot_id: String(snapshot_id).replace(pool, 'clean'),
				})),
			});
			expect(normalize(final)).toEqual(normalize(clean));
		});
	});
});

// migrations/4.0.sql, run by psql the way a DBA runs it, against the 3.0.2 tables of the default pools. psql is on the
// PATH of the CI runners (the spec fails there without it); a machine without it skips these specs.
const psqlAvailable = spawnSync('psql', ['--version']).status === 0;

describe.runIf(psqlAvailable || process.env.CI)('migrations/4.0.sql, run with psql', () => {
	const file = resolve(import.meta.dirname, '../../migrations/4.0.sql');
	const schemas: string[] = [];
	const pools: Pool[] = [];

	const psql = (schemaName: string, variables: Record<string, string>) => {
		const { host, port, user, password, database } = postgresTestConfig();
		return spawnSync(
			'psql',
			['-X', '-q', '-f', file, ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`])],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					PGHOST: String(host),
					PGPORT: String(port),
					PGUSER: String(user),
					PGPASSWORD: String(password),
					PGDATABASE: String(database),
					PGOPTIONS: `-c search_path=${schemaName} -c client_min_messages=warning`,
				},
			},
		);
	};

	/**
	 * A schema of its own with the 3.0.2 tables of the default pools, filled with the corpora of the specs above.
	 */
	const seededSchema = async (): Promise<{ name: string; pool: Pool }> => {
		const name = `es_pgmig_sql_${randomUUID().slice(0, 8)}`;
		await admin.query(`CREATE SCHEMA ${escapeIdentifier(name)}`);
		schemas.push(name);
		const pool = new Pool({ ...config, options: `-c search_path=${name}` });
		pools.push(pool);
		for (const statement of [...v1EventTableStatements('events'), ...v1SnapshotTableStatements('snapshots')]) {
			await pool.query(statement);
		}
		await pool.query(...v1EventInsert('events', eventCorpus()));
		await pool.query(
			...v1SnapshotInsert('snapshots', [
				{
					stream_id: 'account-a1',
					version: 1,
					payload: { balance: 1 },
					snapshot_id: 'snapshot-1',
					aggregate_id: 'a1',
					registered_on: '2024-03-10 12:00:00.123',
					aggregate_name: 'account',
					latest: 'latest#account-a1',
				},
				{
					stream_id: 'account-a1',
					version: 2,
					payload: { balance: 2 },
					snapshot_id: 'snapshot-2',
					aggregate_id: 'a1',
					registered_on: '2024-07-01 12:00:00.456',
					aggregate_name: 'account',
					latest: 'latest#account-a1',
				},
			]),
		);
		return { name, pool };
	};

	const dumps = async ({ name, pool }: { name: string; pool: Pool }) => {
		const normalize = (dumped: Awaited<ReturnType<typeof dump>>) => ({
			...dumped,
			indexes: dumped.indexes.map((index) => index.replaceAll(name, '<schema>')),
		});
		return { events: normalize(await dump('events', pool)), snapshots: normalize(await dump('snapshots', pool)) };
	};

	afterAll(async () => {
		for (const pool of pools) {
			await pool.end();
		}
		for (const name of schemas) {
			await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(name)} CASCADE`);
		}
	});

	it('should migrate like migrate() does, and skip the migrated tables when it runs again', async () => {
		expect.soft(psqlAvailable, 'psql must be on the PATH').toBe(true);
		const byPsql = await seededSchema();
		const byMigrate = await seededSchema();
		const byMigrateConfig = { ...config, options: `-c search_path=${byMigrate.name}` };

		const run = psql(byPsql.name, { legacy_time_zone: 'Europe/Brussels' });
		expect(run.stderr).toBe('');
		expect(run.status).toBe(0);

		await PostgresEventStore.migrate(byMigrateConfig, { pools: [undefined] });
		await PostgresSnapshotStore.migrate(byMigrateConfig, { pools: [undefined], legacyTimeZone: 'Europe/Brussels' });
		expect(await dumps(byPsql)).toEqual(await dumps(byMigrate));
		expect((await dump('snapshots', byPsql.pool)).rows.map(({ registered_on }) => registered_on)).toEqual([
			'2024-03-10T11:00:00.123+00:00',
			'2024-07-01T10:00:00.456+00:00',
		]);

		const migrated = await dumps(byPsql);
		const again = psql(byPsql.name, { legacy_time_zone: 'Europe/Brussels' });
		expect(again.status).toBe(0);
		expect(again.stdout).toContain('events: no 3.x table to migrate, skipped');
		expect(again.stdout).toContain('snapshots: no 3.x table to migrate, skipped');
		expect(await dumps(byPsql)).toEqual(migrated);
	});

	it('should stop before it changes anything without legacy_time_zone', async () => {
		expect.soft(psqlAvailable, 'psql must be on the PATH').toBe(true);
		const seeded = await seededSchema();
		const before = await dumps(seeded);

		const run = psql(seeded.name, {});

		expect(run.status).toBe(0);
		expect(run.stdout).toContain('psql -v legacy_time_zone=<IANA zone> -f migrations/4.0.sql');
		expect(await dumps(seeded)).toEqual(before);
		const { rows } = await seeded.pool.query(`SELECT to_regclass('event_sourcing_collections') IS NULL AS absent`);
		expect(rows).toEqual([{ absent: true }]);
	});
});
