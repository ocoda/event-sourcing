import type { CollectionInspection, ColumnDependent } from '../../lib/migration/inspect.js';
import {
	type CollectionPlan,
	type PlanSettings,
	copyTableName,
	planEventMigration,
	planSnapshotMigration,
} from '../../lib/migration/plan.js';
import {
	type ColumnInfo,
	type IndexInfo,
	type TableInfo,
	eventTableState,
	snapshotTableState,
} from '../../lib/postgres.schema.js';

// The pure planner of migrate(), table by table: no database.

const column = (name: string, type: string, notNull = true, collation: string | null = null): ColumnInfo => ({
	name,
	type,
	notNull,
	collation,
});

const index = (name: string, columns: string[], options: Partial<IndexInfo> = {}): IndexInfo => ({
	name,
	unique: false,
	primary: false,
	valid: true,
	partial: false,
	plain: true,
	method: 'btree',
	columns,
	...options,
});

const dependent = (
	kind: ColumnDependent['kind'],
	object: string,
	column: string,
	options: Partial<ColumnDependent> = {},
): ColumnDependent => ({ kind, object, column, normal: false, ...options });

const columnsOf = (...columns: ColumnInfo[]): Record<string, ColumnInfo> =>
	Object.fromEntries(columns.map((info) => [info.name, info]));

const V1_EVENT_COLUMNS = [
	column('stream_id', 'character varying(120)', true, 'default'),
	column('version', 'integer'),
	column('event', 'character varying(80)', true, 'default'),
	column('payload', 'jsonb'),
	column('event_date', 'character varying(7)', true, 'default'),
	column('event_id', 'character varying(40)', true, 'default'),
	column('aggregate_id', 'character varying(40)', true, 'default'),
	column('occurred_on', 'timestamp with time zone'),
	column('correlation_id', 'character varying(255)', false, 'default'),
	column('causation_id', 'character varying(255)', false, 'default'),
];

const V2_EVENT_COLUMNS = [
	column('stream_id', 'text', true, 'default'),
	column('version', 'integer'),
	column('event', 'text', true, 'default'),
	column('payload', 'jsonb'),
	column('event_id', 'text', true, 'default'),
	column('aggregate_id', 'text', true, 'default'),
	column('occurred_on', 'timestamp with time zone'),
	column('correlation_id', 'text', false, 'default'),
	column('causation_id', 'text', false, 'default'),
	column('global_position', 'bigint'),
	column('headers', 'jsonb', false),
	column('event_version', 'integer', false),
];

const V1_SNAPSHOT_COLUMNS = [
	column('stream_id', 'character varying(90)', true, 'default'),
	column('version', 'integer'),
	column('payload', 'jsonb'),
	column('snapshot_id', 'character varying(40)', true, 'default'),
	column('aggregate_id', 'character varying(40)', true, 'default'),
	column('registered_on', 'timestamp without time zone'),
	column('aggregate_name', 'character varying(50)', true, 'default'),
	column('latest', 'character varying(100)', false, 'default'),
];

const V2_SNAPSHOT_COLUMNS = [
	column('stream_id', 'text', true, 'default'),
	column('version', 'integer'),
	column('payload', 'jsonb'),
	column('snapshot_id', 'text', true, 'default'),
	column('aggregate_id', 'text', true, 'default'),
	column('registered_on', 'timestamp with time zone'),
	column('aggregate_name', 'text', true, 'default'),
	column('latest', 'text', false, 'C'),
];

const table = (columns: ColumnInfo[], indexes: IndexInfo[] = [], extra: Partial<TableInfo> = {}): TableInfo => ({
	oid: 1,
	columns: columnsOf(...columns),
	indexes,
	catalog: true,
	...extra,
});

const inspection = (
	kind: 'events' | 'snapshots',
	info: TableInfo,
	extra: Partial<CollectionInspection> = {},
): CollectionInspection => ({
	kind,
	name: kind,
	table: info,
	state: kind === 'events' ? eventTableState(info) : snapshotTableState(info),
	rows: 3,
	bytes: 1024 * 1024,
	gappedStreams: { total: 0, sample: [] },
	rewrites: [],
	triggers: [],
	publications: [],
	referencingForeignKeys: [],
	columnDependents: [],
	privileges: { owner: true, createInSchema: true, temporary: true, catalog: true },
	...extra,
});

const settings: PlanSettings = { lockTimeoutMs: 10_000, legacyTimeZone: 'Europe/Brussels' };
const stepNames = (plan: CollectionPlan) => plan.steps.map(({ name }) => name);
const statementOf = (plan: CollectionPlan, name: string) => plan.steps.find((step) => step.name === name)?.statement;

describe('eventTableState', () => {
	it.each<[string, TableInfo, string]>([
		['no table', table([], [], { oid: null }), 'absent'],
		['a 3.x table', table(V1_EVENT_COLUMNS), 'v1'],
		['a v2 table', table(V2_EVENT_COLUMNS), 'v2'],
		[
			'event_date and global_position',
			table([...V1_EVENT_COLUMNS, column('global_position', 'bigint', false)]),
			'v1-partial',
		],
		[
			'a nullable global_position',
			table([...V2_EVENT_COLUMNS.slice(0, 9), column('global_position', 'bigint', false)]),
			'v1-partial',
		],
		['neither', table(V2_EVENT_COLUMNS.slice(0, 9)), 'v1-partial'],
	])('%s is %s', (_, info, state) => {
		expect(eventTableState(info)).toBe(state);
	});
});

describe('snapshotTableState', () => {
	const latestIndex = index('idx_snapshots_latest', ['aggregate_name', 'latest'], { unique: true, partial: true });
	it.each<[string, TableInfo, string]>([
		['no table', table([], [], { oid: null }), 'absent'],
		['a 3.x table', table(V1_SNAPSHOT_COLUMNS, [index('idx', ['aggregate_name', 'latest'])]), 'v1'],
		['a v2 table', table(V2_SNAPSHOT_COLUMNS, [latestIndex]), 'v2'],
		['converted columns without the unique index', table(V2_SNAPSHOT_COLUMNS), 'v1-partial'],
		['the unique index on 3.x columns', table(V1_SNAPSHOT_COLUMNS, [latestIndex]), 'v1-partial'],
		['an invalid unique index', table(V2_SNAPSHOT_COLUMNS, [{ ...latestIndex, valid: false }]), 'v1-partial'],
	])('%s is %s', (_, info, state) => {
		expect(snapshotTableState(info)).toBe(state);
	});
});

describe('planEventMigration', () => {
	it('skips an absent table', () => {
		const plan = planEventMigration(inspection('events', table([], [], { oid: null })), settings);
		expect(plan).toMatchObject({ from: 'absent', action: 'skip', steps: [], blocking: [] });
	});

	it.each<[string, TableInfo['entry'], bigint, 'skip' | 'resume']>([
		['a registered table', { kind: 'events', schemaVersion: 2, lastPosition: 10n }, 10n, 'skip'],
		['an unregistered table', undefined, 10n, 'resume'],
		['a counter behind the positions', { kind: 'events', schemaVersion: 2, lastPosition: 9n }, 10n, 'resume'],
		['a row of another kind', { kind: 'snapshots', schemaVersion: 2, lastPosition: 10n }, 10n, 'resume'],
	])('plans %s of a v2 table', (_, entry, maxPosition, action) => {
		const plan = planEventMigration(
			inspection('events', table(V2_EVENT_COLUMNS, [], { entry }), { maxPosition }),
			settings,
		);
		expect(plan.action).toBe(action);
		expect(stepNames(plan)).toEqual(action === 'skip' ? [] : ['register']);
	});

	it('creates the catalog in a transaction of its own before registering a v2 table in a schema without one', () => {
		const plan = planEventMigration(inspection('events', table(V2_EVENT_COLUMNS, [], { catalog: false })), settings);
		expect(stepNames(plan)).toEqual(['create-catalog', 'register']);
		// psql sends the statements one by one: the explicit transaction keeps the advisory lock until the table exists
		expect(statementOf(plan, 'create-catalog')).toMatch(
			/^BEGIN; SELECT pg_advisory_xact_lock\(hashtext\('ocoda:event_sourcing_collections'\)\); CREATE TABLE IF NOT EXISTS event_sourcing_collections \([^;]+\) WITH \(fillfactor = 50\); COMMIT$/,
		);
	});

	it('rewrites a 3.x table in one transaction', () => {
		const plan = planEventMigration(
			inspection('events', table(V1_EVENT_COLUMNS, [index('idx_events_event_date_id', ['event_date', 'event_id'])])),
			settings,
		);

		expect(plan).toMatchObject({
			from: 'v1',
			action: 'migrate',
			blocking: [],
			droppedIndexes: ['idx_events_event_date_id'],
		});
		expect(stepNames(plan)).toEqual([
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
		expect(statementOf(plan, 'begin')).toBe(
			"BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = '10000ms'; SET LOCAL statement_timeout = 0; SET LOCAL work_mem = '64MB'; SET LOCAL maintenance_work_mem = '256MB'",
		);
		expect(statementOf(plan, 'number')).toContain(
			'row_number() OVER (ORDER BY event_date, event_id, stream_id, version) AS legacy_rank',
		);
		expect(statementOf(plan, 'number')).toContain(
			'max(legacy_rank) OVER (PARTITION BY stream_id ORDER BY version ROWS UNBOUNDED PRECEDING) AS stream_key',
		);
		expect(statementOf(plan, 'number')).toContain(
			'row_number() OVER (ORDER BY stream_key, version) AS global_position',
		);
		expect(statementOf(plan, 'widen-columns')).toBe(
			'ALTER TABLE "events" ADD COLUMN IF NOT EXISTS global_position BIGINT, ADD COLUMN IF NOT EXISTS headers JSONB, ADD COLUMN IF NOT EXISTS event_version INTEGER, ALTER COLUMN stream_id TYPE TEXT, ALTER COLUMN event TYPE TEXT, ALTER COLUMN event_id TYPE TEXT, ALTER COLUMN aggregate_id TYPE TEXT, ALTER COLUMN correlation_id TYPE TEXT, ALTER COLUMN causation_id TYPE TEXT',
		);
		expect(statementOf(plan, 'vacuum')).toBe('VACUUM (ANALYZE, PARALLEL 0) "events"');
		expect(plan.warnings).toEqual([expect.stringContaining('Keep about 3.0 MB of disk free')]);
	});

	it('empties the table only in the transaction of the numbered copy, and reinserts without a sort', () => {
		const plan = planEventMigration(inspection('events', table(V1_EVENT_COLUMNS)), settings);
		const copy = copyTableName('events');

		expect(statementOf(plan, 'truncate')).toBe(`DO $migrate$
BEGIN
	IF to_regclass('pg_temp.${copy}') IS NULL THEN
		RAISE EXCEPTION 'The numbered copy ${copy} is missing: run the steps from begin to commit in one transaction';
	END IF;
	TRUNCATE "events";
END $migrate$`);
		expect(statementOf(plan, 'reinsert')).not.toContain('ORDER BY');
		expect(statementOf(plan, 'migration-lock')).toBe(
			`SELECT pg_try_advisory_lock(hashtext('ocoda:migrate'), hashtext(format('%I.%I', current_schema(), 'events'::text))) AS locked`,
		);
	});

	it('keeps the columns a user added, computes generated columns again and keeps identity values', () => {
		const plan = planEventMigration(
			inspection(
				'events',
				table([
					...V1_EVENT_COLUMNS,
					column('tenant', 'text', false),
					column('order', 'integer', false),
					{ ...column('sequence', 'bigint'), identity: true },
					{ ...column('month', 'text', false), generated: true },
				]),
			),
			settings,
		);
		const copied =
			'stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id, "tenant", "order", "sequence"';

		expect(statementOf(plan, 'number')).toContain(
			`SELECT ${copied}, row_number() OVER (ORDER BY stream_key, version) AS global_position`,
		);
		expect(statementOf(plan, 'reinsert')).toBe(
			`INSERT INTO "events" (${copied}, global_position) OVERRIDING SYSTEM VALUE\nSELECT ${copied}, global_position FROM "${copyTableName('events')}"`,
		);
	});

	it.each([
		['a name PostgreSQL truncated', `${'p'.repeat(60)}-events`, 'is 67 bytes long'],
		['a table found with a truncated name', `${'p'.repeat(60)}-ev`, 'a name that PostgreSQL truncated to 63 bytes'],
	])('blocks %s, without steps', (_, name, reason) => {
		const plan = planEventMigration({ ...inspection('events', table(V1_EVENT_COLUMNS)), name }, settings);

		expect(plan).toMatchObject({ action: 'blocked', steps: [] });
		expect(plan.blocking).toEqual([expect.stringContaining(reason)]);
		expect(plan.blocking[0]).toContain('a pool name of at most 56 bytes');
	});

	it('reports the indexes, constraints and statistics that dropping event_date drops', () => {
		const plan = planEventMigration(
			inspection('events', table(V1_EVENT_COLUMNS, [index('idx_events_event_date_id', ['event_date', 'event_id'])]), {
				columnDependents: [
					dependent('index', 'index idx_events_event_date_id', 'event_date', { index: 'idx_events_event_date_id' }),
					dependent('index', 'index events_month', 'event_date', { index: 'events_month' }),
					dependent('index', 'index events_recent', 'event_date', { index: 'events_recent' }),
					dependent('constraint', 'constraint dated on table events', 'event_date', { normal: true }),
					dependent('statistics', 'statistics object events_stats', 'event_date'),
					dependent('constraint', 'constraint events_pkey on table events', 'stream_id'),
					dependent('index', 'index events_ids', 'event_id', { index: 'events_ids' }),
				],
			}),
			settings,
		);

		expect(plan).toMatchObject({ action: 'migrate', blocking: [] });
		expect(plan.droppedIndexes).toEqual(['events_month', 'events_recent', 'idx_events_event_date_id']);
		expect(plan.warnings).toEqual(
			expect.arrayContaining([
				'The migration drops constraint dated on table events, which uses event_date.',
				'The migration drops statistics object events_stats, which uses event_date.',
			]),
		);
	});

	it.each<[string, ColumnDependent, string]>([
		[
			'a policy on event_date',
			dependent('policy', 'policy dates on table events', 'event_date', { normal: true }),
			'The policy dates on table events uses event_date, which the migration drops',
		],
		[
			'a generated column of event_date',
			dependent('generated column', 'column month of table events', 'event_date'),
			'The column month of table events uses event_date, which the migration drops',
		],
		[
			'a trigger on a widened column',
			dependent('trigger', 'trigger audit on table events', 'stream_id', { normal: true }),
			'The trigger audit on table events uses stream_id, which the migration converts to another type',
		],
		[
			'a publication row filter on event_date',
			dependent('publication', 'publication of table events in publication cdc', 'event_date', { normal: true }),
			'publication cdc uses event_date',
		],
		[
			'an unknown object that event_date keeps',
			dependent('other', 'something else', 'event_date', { normal: true }),
			'The something else uses event_date',
		],
	])('blocks %s', (_, columnDependent, reason) => {
		const plan = planEventMigration(
			inspection('events', table(V1_EVENT_COLUMNS), { columnDependents: [columnDependent] }),
			settings,
		);
		expect(plan.action).toBe('blocked');
		expect(plan.blocking).toEqual([expect.stringContaining(reason)]);
	});

	it('does not block on objects of columns it keeps', () => {
		const plan = planEventMigration(
			inspection('events', table(V1_EVENT_COLUMNS), {
				columnDependents: [
					dependent('policy', 'policy tenants on table events', 'payload', { normal: true }),
					dependent('trigger', 'trigger audit on table events', 'version', { normal: true }),
				],
			}),
			settings,
		);
		expect(plan).toMatchObject({ action: 'migrate', blocking: [] });
	});

	it('only widens the columns that are not text yet', () => {
		const columns = V1_EVENT_COLUMNS.map((info) => (info.name === 'stream_id' ? column('stream_id', 'text') : info));
		const plan = planEventMigration(inspection('events', table(columns)), settings);
		expect(statementOf(plan, 'widen-columns')).not.toContain('stream_id TYPE TEXT');
		expect(statementOf(plan, 'widen-columns')).toContain('event_id TYPE TEXT');
	});

	it('resumes a partly migrated table that still has event_date', () => {
		const plan = planEventMigration(
			inspection('events', table([...V1_EVENT_COLUMNS, column('global_position', 'bigint', false)])),
			settings,
		);
		expect(plan).toMatchObject({ from: 'v1-partial', action: 'resume', blocking: [] });
	});

	it.each<[string, Partial<CollectionInspection>, TableInfo, string]>([
		['a partly migrated table without event_date', {}, table(V2_EVENT_COLUMNS.slice(0, 9)), 'without event_date'],
		[
			'a table the role does not own',
			{ privileges: { owner: false, createInSchema: true, temporary: true, catalog: true } },
			table(V1_EVENT_COLUMNS),
			"doesn't own",
		],
		[
			'a role without temporary tables',
			{ privileges: { owner: true, createInSchema: true, temporary: false, catalog: true } },
			table(V1_EVENT_COLUMNS),
			'temporary tables',
		],
		[
			'a schema without catalog where the role may not create it',
			{ privileges: { owner: true, createInSchema: false, temporary: true, catalog: true } },
			table(V1_EVENT_COLUMNS, [], { catalog: false }),
			'may not create tables',
		],
		[
			'a view on event_date',
			{ rewrites: [{ name: 'monthly', columns: ['event_date'] }] },
			table(V1_EVENT_COLUMNS),
			'monthly uses event_date',
		],
		[
			'a view on a widened column',
			{ rewrites: [{ name: 'ids', columns: ['event_id', 'payload'] }] },
			table(V1_EVENT_COLUMNS),
			'ids uses event_id',
		],
		[
			'a view on the whole row',
			{ rewrites: [{ name: 'whole', columns: [null] }] },
			table(V1_EVENT_COLUMNS),
			'whole uses the whole row',
		],
		[
			'a referencing foreign key',
			{ referencingForeignKeys: ['refs.refs_fkey'] },
			table(V1_EVENT_COLUMNS),
			'refs.refs_fkey reference',
		],
		[
			'a role that may not write the catalog',
			{ privileges: { owner: true, createInSchema: true, temporary: true, catalog: false } },
			table(V1_EVENT_COLUMNS),
			'grant it SELECT, INSERT and UPDATE on the catalog',
		],
	])('blocks %s', (_, extra, info, reason) => {
		const plan = planEventMigration(inspection('events', info, extra), settings);
		expect(plan.action).toBe('blocked');
		expect(plan.blocking.join('\n')).toContain(reason);
	});

	it('allows a missing catalog when the role may create it, and a view on unchanged columns', () => {
		const plan = planEventMigration(
			inspection('events', table(V1_EVENT_COLUMNS, [], { catalog: false }), {
				rewrites: [{ name: 'amounts', columns: ['version', 'payload'] }],
			}),
			settings,
		);
		expect(plan).toMatchObject({ action: 'migrate', blocking: [], dependents: ['view or rule amounts'] });
		expect(stepNames(plan)[0]).toBe('create-catalog');
	});

	it('warns about gapped streams, duplicate ids, publications and triggers', () => {
		const plan = planEventMigration(
			inspection('events', table(V1_EVENT_COLUMNS), {
				bytes: undefined,
				gappedStreams: { total: 2, sample: [] },
				duplicateEventIds: 1,
				publications: ['cdc'],
				triggers: [
					{ name: 'audit', events: ['INSERT'], enabled: true },
					{ name: 'on_truncate', events: ['TRUNCATE'], enabled: true },
					{ name: 'off', events: ['INSERT'], enabled: false },
					{ name: 'on_update', events: ['UPDATE'], enabled: true },
				],
			}),
			settings,
		);

		expect(plan.action).toBe('migrate');
		expect(plan.dependents).toEqual([
			'trigger audit (INSERT)',
			'trigger on_truncate (TRUNCATE)',
			'trigger off (INSERT, disabled)',
			'trigger on_update (UPDATE)',
			'publication cdc',
		]);
		expect(plan.warnings).toEqual([
			expect.stringContaining('2 stream(s) have versions'),
			expect.stringContaining('1 event id(s) are stored more than once'),
			expect.stringContaining('The publication cdc receives a TRUNCATE'),
			expect.stringContaining('The trigger audit fires'),
			expect.stringContaining('The trigger on_truncate fires'),
		]);
	});
});

describe('planSnapshotMigration', () => {
	const legacyIndex = index('idx_snapshots_aggregate_name_latest', ['aggregate_name', 'latest']);
	const latestIndex = index('idx_snapshots_latest', ['aggregate_name', 'latest'], { unique: true, partial: true });

	it('skips an absent table', () => {
		expect(planSnapshotMigration(inspection('snapshots', table([], [], { oid: null })), settings)).toMatchObject({
			action: 'skip',
			steps: [],
		});
	});

	it.each<[string, TableInfo['entry'], 'skip' | 'resume']>([
		['a registered table', { kind: 'snapshots', schemaVersion: 2, lastPosition: 0n }, 'skip'],
		['a table registered as 3.x', { kind: 'snapshots', schemaVersion: 1, lastPosition: 0n }, 'resume'],
		['an unregistered table', undefined, 'resume'],
	])('plans %s of a v2 table', (_, entry, action) => {
		const plan = planSnapshotMigration(
			inspection('snapshots', table(V2_SNAPSHOT_COLUMNS, [latestIndex], { entry })),
			settings,
		);
		expect(plan.action).toBe(action);
		expect(stepNames(plan)).toEqual(action === 'skip' ? [] : ['register']);
	});

	it('converts a 3.x table in one transaction, reading registered_on in the legacy time zone', () => {
		const plan = planSnapshotMigration(
			inspection('snapshots', table(V1_SNAPSHOT_COLUMNS, [legacyIndex]), {
				snapshotFlags: { duplicateLatest: 1, missingLatest: 2 },
			}),
			settings,
		);

		expect(plan).toMatchObject({
			from: 'v1',
			action: 'migrate',
			droppedIndexes: ['idx_snapshots_aggregate_name_latest'],
			snapshotFlags: { duplicateLatest: 1, missingLatest: 2 },
			gappedStreams: { total: 0, sample: [] },
		});
		expect(stepNames(plan)).toEqual([
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
		]);
		expect(statementOf(plan, 'drop-legacy-indexes')).toBe('DROP INDEX "idx_snapshots_aggregate_name_latest"');
		expect(statementOf(plan, 'convert-columns')).toBe(
			`ALTER TABLE "snapshots" ALTER COLUMN stream_id TYPE TEXT, ALTER COLUMN snapshot_id TYPE TEXT, ALTER COLUMN aggregate_id TYPE TEXT, ALTER COLUMN aggregate_name TYPE TEXT, ALTER COLUMN latest TYPE TEXT COLLATE "C", ALTER COLUMN registered_on TYPE TIMESTAMPTZ USING registered_on AT TIME ZONE 'Europe/Brussels'`,
		);
		expect(plan.warnings).toEqual([
			expect.stringContaining('1 stream(s) have several snapshots flagged'),
			expect.stringContaining('read in Europe/Brussels'),
			expect.stringContaining('rewrites the table and its indexes under the lock: keep about 1.0 MB of disk free'),
		]);
	});

	it.each(['UTC', 'Etc/UTC'])('converts registered_on without a rewrite in %s', (legacyTimeZone) => {
		const plan = planSnapshotMigration(inspection('snapshots', table(V1_SNAPSHOT_COLUMNS)), {
			...settings,
			legacyTimeZone,
		});
		expect(statementOf(plan, 'convert-columns')).toMatch(
			/^SET LOCAL TimeZone = 'UTC'; ALTER TABLE .*ALTER COLUMN registered_on TYPE TIMESTAMPTZ$/,
		);
		expect(stepNames(plan)).not.toContain('drop-legacy-indexes');
	});

	it('writes the time zone as given SQL for the committed migration file', () => {
		const plan = planSnapshotMigration(inspection('snapshots', table(V1_SNAPSHOT_COLUMNS)), {
			...settings,
			legacyTimeZone: 'UTC',
			timeZoneSql: ":'legacy_time_zone'",
		});
		expect(statementOf(plan, 'convert-columns')).toContain("AT TIME ZONE :'legacy_time_zone'");
	});

	it('only converts the columns that need it', () => {
		const partly = V2_SNAPSHOT_COLUMNS.map((info) =>
			info.name === 'aggregate_name' ? column('aggregate_name', 'character varying(50)') : info,
		);
		const plan = planSnapshotMigration(inspection('snapshots', table(partly)), settings);
		expect(plan.from).toBe('v1-partial');
		expect(plan.action).toBe('resume');
		expect(statementOf(plan, 'convert-columns')).toBe('ALTER TABLE "snapshots" ALTER COLUMN aggregate_name TYPE TEXT');

		const converted = planSnapshotMigration(inspection('snapshots', table(V2_SNAPSHOT_COLUMNS)), settings);
		expect(stepNames(converted)).not.toContain('convert-columns');
	});

	it.each<[string, Partial<CollectionInspection>, string]>([
		['a view on latest', { rewrites: [{ name: 'latest_view', columns: ['latest'] }] }, 'latest_view uses latest'],
		['a referencing foreign key', { referencingForeignKeys: ['refs.fk'] }, 'refs.fk reference'],
		[
			'a table the role does not own',
			{ privileges: { owner: false, createInSchema: true, temporary: true, catalog: true } },
			"doesn't own",
		],
		[
			'a policy on a converted column',
			{
				columnDependents: [dependent('policy', 'policy recent on table snapshots', 'registered_on', { normal: true })],
			},
			'The policy recent on table snapshots uses registered_on, which the migration converts to another type',
		],
	])('blocks %s', (_, extra, reason) => {
		const plan = planSnapshotMigration(inspection('snapshots', table(V1_SNAPSHOT_COLUMNS), extra), settings);
		expect(plan.action).toBe('blocked');
		expect(plan.blocking.join('\n')).toContain(reason);
	});

	it('blocks a table found with a truncated name, without steps', () => {
		const name = `${'p'.repeat(60)}-sn`;
		const plan = planSnapshotMigration({ ...inspection('snapshots', table(V1_SNAPSHOT_COLUMNS)), name }, settings);
		expect(plan).toMatchObject({ action: 'blocked', steps: [] });
		expect(plan.blocking).toEqual([expect.stringContaining('a pool name of at most 53 bytes')]);
	});

	it('keeps the indexes and constraints on the converted columns, which PostgreSQL rebuilds', () => {
		const plan = planSnapshotMigration(
			inspection('snapshots', table(V1_SNAPSHOT_COLUMNS), {
				columnDependents: [
					dependent('index', 'index snapshots_names', 'aggregate_name', { index: 'snapshots_names' }),
					dependent('constraint', 'constraint named on table snapshots', 'aggregate_name', { normal: true }),
				],
			}),
			settings,
		);
		expect(plan).toMatchObject({ action: 'migrate', blocking: [] });
	});
});
