import type { Queryable } from '../../lib/mariadb.schema.js';
import { connectionConfigOf, eventTableOf, failureHint, maxWriteSetBytesOf } from '../../lib/migration/migrate.js';
import {
	type EventPlanInput,
	GALERA_WARNINGS,
	type PlanOptions,
	type SnapshotPlanInput,
	planEventMigration,
	planSnapshotMigration,
} from '../../lib/migration/plan.js';
import {
	DEFAULT_STATEMENT_OPTIONS,
	GALERA_FRAGMENT_BYTES,
	GALERA_MIN_FRAGMENT_BYTES,
	galeraFragmentBytesOf,
	sessionSql,
} from '../../lib/migration/sql.js';

/**
 * The migration planner is a pure function of what the migration found in a table (plan.ts): these tables pin every
 * branch, without a database. The migration spec runs the plans against real tables.
 */

const OPTIONS: PlanOptions = { ...DEFAULT_STATEMENT_OPTIONS, keepBackup: true, repairOccurredOn: true };
const OPENING = ['session', 'create-catalog', 'acquire-lock'];

const event = (input: Partial<EventPlanInput> = {}): EventPlanInput => ({
	table: 'tenant-events',
	state: 'v1',
	registered: false,
	hasColumns: true,
	backup: false,
	dependents: [],
	...input,
});

const snapshot = (input: Partial<SnapshotPlanInput> = {}): SnapshotPlanInput => ({
	table: 'tenant-snapshots',
	state: 'v1',
	registered: false,
	hasColumns: true,
	columnsConverted: false,
	latestIndexes: ['idx_aggregate_name_latest'],
	uniqueLatest: false,
	dependents: [],
	...input,
});

describe('planEventMigration', () => {
	it.each([
		{ case: 'no table', input: event({ state: 'absent' }), options: OPTIONS, action: 'skip', steps: [] },
		{
			case: 'a 3.x table',
			input: event(),
			options: OPTIONS,
			action: 'migrate',
			steps: [
				...OPENING,
				'drop-copy',
				'create-copy',
				'bulk-load-on',
				'copy',
				'bulk-load-off',
				'swap',
				'catch-up',
				'register',
				'release-lock',
			],
		},
		{
			case: 'a 3.x table, without keeping the backup',
			input: event(),
			options: { ...OPTIONS, keepBackup: false },
			action: 'migrate',
			steps: [
				...OPENING,
				'drop-copy',
				'create-copy',
				'bulk-load-on',
				'copy',
				'bulk-load-off',
				'swap',
				'catch-up',
				'register',
				'drop-backup',
				'release-lock',
			],
		},
		{
			case: 'a table swapped by a migration that stopped (v1-partial with its backup)',
			input: event({ state: 'v1-partial', backup: true }),
			options: OPTIONS,
			action: 'resume',
			steps: [...OPENING, 'catch-up', 'register', 'release-lock'],
		},
		{
			case: 'a v2 table without a catalog row',
			input: event({ state: 'v2' }),
			options: OPTIONS,
			action: 'resume',
			steps: [...OPENING, 'register', 'release-lock'],
		},
		{
			case: 'a v2 table without a catalog row, with dependents (they stay on the table)',
			input: event({ state: 'v2', dependents: ['trigger audit'] }),
			options: OPTIONS,
			action: 'resume',
			steps: [...OPENING, 'register', 'release-lock'],
		},
		{
			case: 'a registered v2 table',
			input: event({ state: 'v2', registered: true }),
			options: OPTIONS,
			action: 'skip',
			steps: [],
		},
		{
			case: 'a registered v2 table whose backup is kept',
			input: event({ state: 'v2', registered: true, backup: true }),
			options: OPTIONS,
			action: 'skip',
			steps: [],
		},
		{
			case: 'a registered v2 table whose backup is to be dropped',
			input: event({ state: 'v2', registered: true, backup: true }),
			options: { ...OPTIONS, keepBackup: false },
			action: 'resume',
			steps: [...OPENING, 'drop-backup', 'release-lock'],
		},
	])('$case: $action', ({ input, options, action, steps }) => {
		const plan = planEventMigration(input, options);

		expect(plan.action).toBe(action);
		expect(plan.steps.map(({ name }) => name)).toEqual(steps);
		expect(plan.blocking).toEqual([]);
		for (const { statement, lock } of plan.steps) {
			expect(statement).not.toBe('');
			expect(lock).not.toBe('');
		}
	});

	it.each([
		{
			case: 'a table without the columns of an event table',
			input: event({ hasColumns: false }),
			blocking: [/lacks columns of an event table/],
		},
		{
			case: 'a 3.x table with triggers or foreign keys',
			input: event({ dependents: ['trigger audit', 'foreign key fk (a -> tenant-events)'] }),
			blocking: [/dependents .*trigger audit, foreign key fk/],
		},
		{
			case: 'a 3.x table whose backup exists already',
			input: event({ backup: true }),
			blocking: [/backup tenant-events__es_v1 already exists/],
		},
		{
			case: 'a 3.x table with dependents and a backup',
			input: event({ backup: true, dependents: ['trigger audit'] }),
			blocking: [/dependents/, /already exists/],
		},
		{
			case: 'a table that is neither 3.x nor v2, without a backup',
			input: event({ state: 'v1-partial' }),
			blocking: [/neither the 3\.x schema nor schema v2/],
		},
		{
			case: 'a swapped table with dependents',
			input: event({ state: 'v1-partial', backup: true, dependents: ['trigger audit'] }),
			blocking: [/dependents/],
		},
	])('$case: blocked, with no steps', ({ input, blocking }) => {
		const plan = planEventMigration(input, OPTIONS);

		expect(plan).toMatchObject({ action: 'blocked', steps: [] });
		expect(plan.blocking).toEqual(blocking.map((pattern) => expect.stringMatching(pattern)));
	});

	it('warns that the backup is kept, with the statement that drops it', () => {
		expect(planEventMigration(event(), OPTIONS).warnings).toEqual([
			'The 3.x table is kept as tenant-events__es_v1; drop it when satisfied: DROP TABLE IF EXISTS `tenant-events__es_v1`',
		]);
		expect(planEventMigration(event(), { ...OPTIONS, keepBackup: false }).warnings).toEqual([]);
	});

	it('warns about Galera for the tables it migrates or resumes', () => {
		const galera = { ...OPTIONS, galera: true };

		expect(planEventMigration(event(), galera).warnings).toContain(GALERA_WARNINGS.events);
		expect(planEventMigration(event({ state: 'v2' }), galera).warnings).toContain(GALERA_WARNINGS.events);
		expect(planEventMigration(event({ state: 'v2', registered: true }), galera).warnings).toEqual([]);
		expect(planEventMigration(event({ hasColumns: false }), galera).warnings).toEqual([]);
		expect(planEventMigration(event(), OPTIONS).warnings).not.toContain(GALERA_WARNINGS.events);
	});

	it('shapes the statements by the options: lock wait, backslash escapes, occurred_on repair', () => {
		const statements = (options: PlanOptions) =>
			Object.fromEntries(
				planEventMigration(event({ table: "o'neil\\-events" }), options).steps.map(({ name, statement }) => [
					name,
					statement,
				]),
			);

		const defaults = statements(OPTIONS);
		expect(defaults.session).toMatch(/lock_wait_timeout = 10, innodb_lock_wait_timeout = 10/);
		expect(defaults['acquire-lock']).toContain("'o''neil\\\\-events'");
		expect(defaults.copy).toMatch(/CASE WHEN .* THEN FROM_UNIXTIME/);

		const custom = statements({ ...OPTIONS, lockWaitSeconds: 3, noBackslashEscapes: true, repairOccurredOn: false });
		expect(custom.session).toMatch(/lock_wait_timeout = 3, innodb_lock_wait_timeout = 3/);
		expect(custom['acquire-lock']).toContain("'o''neil\\-events'");
		expect(custom.copy).not.toMatch(/FROM_UNIXTIME/);
		expect(custom.copy).toMatch(/k\.causation_id/);
		// Either way, the copy gives every 3.x stream the stream id of its lowest version
		for (const copy of [defaults.copy, custom.copy]) {
			expect(copy).toMatch(/^SELECT k\.first_stream_id, /m);
			expect(copy).toContain(
				'FIRST_VALUE(r.stream_id) OVER (PARTITION BY r.stream_id ORDER BY r.version ROWS UNBOUNDED PRECEDING) AS first_stream_id',
			);
		}
	});
});

describe('planSnapshotMigration', () => {
	it.each([
		{ case: 'no table', input: snapshot({ state: 'absent' }), action: 'skip', steps: [] },
		{ case: 'a registered v2 table', input: snapshot({ state: 'v2', registered: true }), action: 'skip', steps: [] },
		{
			case: 'a 3.x table',
			input: snapshot(),
			action: 'migrate',
			steps: [
				...OPENING,
				'canonicalize',
				'convert',
				'unflag-superseded',
				'flag-latest',
				'add-unique-latest',
				'register',
				'release-lock',
			],
		},
		{
			case: 'a 3.x table without an index on the flag',
			input: snapshot({ latestIndexes: [] }),
			action: 'migrate',
			steps: [
				...OPENING,
				'canonicalize',
				'convert',
				'unflag-superseded',
				'flag-latest',
				'add-unique-latest',
				'register',
				'release-lock',
			],
		},
		{
			case: 'a table converted by a migration that stopped',
			input: snapshot({ state: 'v1-partial', columnsConverted: true, latestIndexes: [] }),
			action: 'resume',
			steps: [...OPENING, 'unflag-superseded', 'flag-latest', 'add-unique-latest', 'register', 'release-lock'],
		},
		{
			case: 'a converted table that still has a non-unique index on the flag',
			input: snapshot({ state: 'v1-partial', columnsConverted: true }),
			action: 'resume',
			steps: [
				...OPENING,
				'convert',
				'unflag-superseded',
				'flag-latest',
				'add-unique-latest',
				'register',
				'release-lock',
			],
		},
		{
			case: 'a converted table with its unique index, not registered',
			input: snapshot({ state: 'v1-partial', columnsConverted: true, latestIndexes: [], uniqueLatest: true }),
			action: 'resume',
			steps: [...OPENING, 'unflag-superseded', 'flag-latest', 'register', 'release-lock'],
		},
		{
			case: 'a v2 table without a catalog row',
			input: snapshot({ state: 'v2', columnsConverted: true, latestIndexes: [], uniqueLatest: true }),
			action: 'resume',
			steps: [...OPENING, 'register', 'release-lock'],
		},
		{
			case: 'a v2 table without a catalog row, with dependents',
			input: snapshot({
				state: 'v2',
				columnsConverted: true,
				latestIndexes: [],
				uniqueLatest: true,
				dependents: ['t'],
			}),
			action: 'resume',
			steps: [...OPENING, 'register', 'release-lock'],
		},
	])('$case: $action', ({ input, action, steps }) => {
		const plan = planSnapshotMigration(input, OPTIONS);

		expect(plan.action).toBe(action);
		expect(plan.steps.map(({ name }) => name)).toEqual(steps);
		expect(plan.blocking).toEqual([]);
	});

	it('canonicalizes the stream ids before the conversion, from the events when the pool has 3.x events', () => {
		const statementOf = (input: SnapshotPlanInput) =>
			planSnapshotMigration(input, OPTIONS).steps.find(({ name }) => name === 'canonicalize')?.statement;

		const own = statementOf(snapshot());
		expect(own).toMatch(/^UPDATE `tenant-snapshots` s JOIN \(/);
		expect(own).toMatch(/s\.registered_on = s\.registered_on/);
		expect(own).not.toMatch(/event_stream_id/);

		const fromEvents = statementOf(snapshot({ events: 'tenant-events__es_v1' }));
		expect(fromEvents).toContain(
			'(SELECT e.stream_id FROM `tenant-events__es_v1` e WHERE e.stream_id = g.stream_id ORDER BY e.version LIMIT 1) AS event_stream_id',
		);
		expect(fromEvents).toMatch(/COALESCE\(a\.event_stream_id, a\.first_stream_id\) AS stream_id/);

		// A converted table compares in binary: its canonicalization ran before the conversion
		expect(statementOf(snapshot({ state: 'v1-partial', columnsConverted: true }))).toBeUndefined();
	});

	it('drops the non-unique indexes on the flag in the conversion', () => {
		const [convert] = planSnapshotMigration(snapshot({ latestIndexes: ['a', 'b'] }), OPTIONS).steps.filter(
			({ name }) => name === 'convert',
		);
		expect(convert.statement).toMatch(/DROP INDEX `a`,\n {2}DROP INDEX `b`,\n {2}ALGORITHM=COPY, LOCK=SHARED$/);
	});

	it.each([
		{
			case: 'a table without the columns of a snapshot table',
			input: snapshot({ hasColumns: false }),
			blocking: /lacks columns of a snapshot table/,
		},
		{
			case: 'a 3.x table with triggers or foreign keys',
			input: snapshot({ dependents: ['trigger t'] }),
			blocking: /triggers or foreign keys: trigger t/,
		},
	])('$case: blocked, with no steps', ({ input, blocking }) => {
		expect(planSnapshotMigration(input, OPTIONS)).toEqual({
			action: 'blocked',
			steps: [],
			warnings: [],
			blocking: [expect.stringMatching(blocking)],
		});
	});

	it('warns about Galera for the tables it migrates or resumes', () => {
		const galera = { ...OPTIONS, galera: true };

		expect(planSnapshotMigration(snapshot(), galera).warnings).toEqual([GALERA_WARNINGS.snapshots]);
		expect(planSnapshotMigration(snapshot({ state: 'v2', registered: true }), galera).warnings).toEqual([]);
		expect(planSnapshotMigration(snapshot(), OPTIONS).warnings).toEqual([]);
	});
});

describe('the session of a migration', () => {
	it('is UTC, REPEATABLE READ, with bounded lock waits and no statement time limit', () => {
		expect(sessionSql(DEFAULT_STATEMENT_OPTIONS)).toBe(
			"SET SESSION time_zone = '+00:00', lock_wait_timeout = 10, innodb_lock_wait_timeout = 10, max_statement_time = 0, tx_isolation = 'REPEATABLE-READ'",
		);
	});

	it('replicates in fragments on Galera', () => {
		expect(sessionSql({ ...DEFAULT_STATEMENT_OPTIONS, galera: true })).toMatch(
			new RegExp(`, wsrep_trx_fragment_unit = 'bytes', wsrep_trx_fragment_size = ${GALERA_FRAGMENT_BYTES}$`),
		);
		expect(sessionSql({ ...DEFAULT_STATEMENT_OPTIONS, galera: true, galeraFragmentBytes: 5_000_000 })).toMatch(
			/, wsrep_trx_fragment_size = 5000000$/,
		);
	});

	it("sizes the fragments for the node's largest write set, so that nobody has to", () => {
		const MiB = 1024 * 1024;
		expect(galeraFragmentBytesOf(undefined)).toBe(GALERA_FRAGMENT_BYTES);
		expect(galeraFragmentBytesOf(Number.NaN)).toBe(GALERA_FRAGMENT_BYTES);
		expect(galeraFragmentBytesOf(0)).toBe(GALERA_FRAGMENT_BYTES);
		// The default wsrep_max_ws_size is 2 GiB
		expect(galeraFragmentBytesOf(2 * 1024 * MiB - 1)).toBe(64 * MiB);
		expect(galeraFragmentBytesOf(128 * MiB)).toBe(64 * MiB);
		expect(galeraFragmentBytesOf(100 * MiB)).toBe(50 * MiB);
		expect(galeraFragmentBytesOf(1 * MiB)).toBe(GALERA_MIN_FRAGMENT_BYTES);
	});

	it("reads a Galera node's largest write set, and does without it", async () => {
		const answering = (rows: unknown) => ({ query: async () => rows }) as Queryable;
		expect(await maxWriteSetBytesOf(answering([{ bytes: 2147483647n }]))).toBe(2147483647);
		expect(await maxWriteSetBytesOf(answering([{ bytes: null }]))).toBeUndefined();
		expect(await maxWriteSetBytesOf(answering([]))).toBeUndefined();
		expect(
			await maxWriteSetBytesOf({
				query: async () => {
					throw Object.assign(new Error('Unknown system variable'), { errno: 1193 });
				},
			}),
		).toBeUndefined();
	});
});

describe('failureHint', () => {
	const rerun = /run the migration again: it continues where it stopped\./i;

	it.each([
		{ case: 'any failure', step: 'swap', error: new Error('boom'), hint: /^Run the migration again/ },
		{ case: 'a lock wait timeout', step: 'copy', error: { errno: 1205 }, hint: /^A session still uses the table/ },
		{
			case: 'lock memory at the copy',
			step: 'copy',
			error: { errno: 1206 },
			hint: /increase innodb_buffer_pool_size .* READ COMMITTED before the copy/,
		},
		{ case: 'lock memory elsewhere', step: 'convert', error: { errno: 1206 }, hint: /^Run the migration again/ },
		{
			case: 'a full tmpdir',
			step: 'copy',
			error: { errno: 1296, message: "Got error 59 'Temp file write failure' from InnoDB" },
			hint: /tmpdir \(@@tmpdir\), which needs about 1\.5 times the event table/,
		},
		{ case: 'a full disk', step: 'copy', error: { errno: 1021 }, hint: /ran out of disk space/ },
		{
			case: 'a full temporary table',
			step: 'copy',
			error: { errno: 1114, message: "The table '/tmp/#sql-temptable-1' is full" },
			hint: /ran out of disk space/,
		},
		{
			case: 'ENOSPC',
			step: 'copy',
			error: { message: 'Error writing file (Errcode: 28 "No space left on device")' },
			hint: /ran out of disk space/,
		},
		{
			case: "Galera's largest write set",
			step: 'copy',
			error: { errno: 1105, message: 'Maximum writeset size exceeded' },
			hint: /in fragments of half of wsrep_max_ws_size read when it started \(67108864 bytes at most, 1048576 at least\)/,
		},
		{
			case: 'a missing privilege',
			step: 'swap',
			error: { errno: 1142, message: "ALTER command denied to user 'app'@'%' for table 'events'" },
			hint: /lacks a privilege: it needs SELECT, INSERT, UPDATE, CREATE, ALTER and DROP/,
		},
		{ case: 'a missing database privilege', step: 'create-catalog', error: { errno: 1044 }, hint: /lacks a privilege/ },
		{
			case: 'a lost connection',
			step: 'copy',
			error: { errno: 45026, fatal: true, message: 'socket timeout' },
			hint: /server may still be running the step: wait until SELECT IS_USED_LOCK\(CONCAT\('ocoda:migrate:', SHA1\(CONCAT\(DATABASE\(\), '\.', 'events'\)\)\)\) returns NULL/,
		},
	])('$case', ({ step, error, hint }) => {
		const text = failureHint(step, error, 'events');
		expect(text).toMatch(hint);
		expect(text).toMatch(rerun);
	});
});

describe('eventTableOf', () => {
	it("names the event table of a snapshot table's pool", () => {
		expect(eventTableOf('snapshots')).toBe('events');
		expect(eventTableOf('tenant-snapshots')).toBe('tenant-events');
		expect(eventTableOf('a-b-snapshots')).toBe('a-b-events');
		expect(eventTableOf('-snapshots')).toBeUndefined();
		expect(eventTableOf('other')).toBeUndefined();
	});
});

describe('connectionConfigOf', () => {
	it("keeps the connection options of a store's configuration, without its own options and a socket timeout", () => {
		expect(
			connectionConfigOf({
				driver: class {},
				useDefaultPool: true,
				ddl: 'none',
				host: 'db',
				database: 'app',
				socketTimeout: 1000,
				initSql: 'SET SESSION a = 1',
			}),
		).toEqual({ host: 'db', database: 'app', socketTimeout: 0, initSql: 'SET SESSION a = 1' });
	});
});
