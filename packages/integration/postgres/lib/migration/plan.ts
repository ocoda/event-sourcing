import { createHash } from 'node:crypto';
import type { MigrationCollectionReport, MigrationStep } from '@ocoda/event-sourcing';
import { escapeIdentifier, escapeLiteral } from 'pg';
import { MAX_IDENTIFIER_BYTES } from '../postgres.helpers.js';
import {
	CATALOG,
	SCHEMA_VERSION,
	catalogStatement,
	findLegacyLatestIndexes,
	latestIndexStatement,
	literalRegisterEventsStatement,
	literalRegisterSnapshotsStatement,
	positionIndexStatement,
} from '../postgres.schema.js';
import type { CollectionInspection, ColumnDependent } from './inspect.js';

// The pure planner of migrate() (ADR 0002 §6, amended by the Wave 0 spikes): from an inspection, the report of a
// collection with the exact statements that migrate it. No I/O, so the plans are unit-tested table by table.

export interface PlanSettings {
	/** How long the migration waits for the table lock, in milliseconds. */
	lockTimeoutMs: number;
	/** Snapshots: the IANA time zone the 3.x `TIMESTAMP` `registered_on` values were written in. */
	legacyTimeZone: string;
	/**
	 * Snapshots: the SQL that stands for the time zone in the statements, instead of the literal of `legacyTimeZone`
	 * (the committed migration SQL uses a psql variable). Never takes the UTC shortcut.
	 */
	timeZoneSql?: string;
}

/**
 * The names of the steps, in the order they run. The steps from `begin` to `commit` run in one transaction.
 */
export type StepName =
	| 'create-catalog'
	| 'migration-lock'
	| 'begin'
	| 'lock'
	| 'number'
	| 'widen-columns'
	| 'truncate'
	| 'drop-event-date'
	| 'reinsert'
	| 'index-positions'
	| 'drop-legacy-indexes'
	| 'unflag'
	| 'flag'
	| 'convert-columns'
	| 'index-latest'
	| 'register'
	| 'commit'
	| 'vacuum';

export interface PlannedStep extends MigrationStep {
	name: StepName;
}

export interface CollectionPlan extends MigrationCollectionReport {
	steps: PlannedStep[];
}

/**
 * The event columns that 3.x created as `VARCHAR` and v2 as `TEXT`.
 */
export const EVENT_TEXT_COLUMNS = [
	'stream_id',
	'event',
	'event_id',
	'aggregate_id',
	'correlation_id',
	'causation_id',
] as const;

/**
 * The snapshot columns that 3.x created as `VARCHAR` and v2 as `TEXT` (`latest` is handled on its own).
 */
export const SNAPSHOT_TEXT_COLUMNS = ['stream_id', 'snapshot_id', 'aggregate_id', 'aggregate_name'] as const;

/**
 * The columns of the event tables that 3.x and 4.x create, which the statements name without quotes.
 */
const KNOWN_EVENT_COLUMNS = new Set([
	'stream_id',
	'version',
	'event',
	'payload',
	'event_date',
	'event_id',
	'aggregate_id',
	'occurred_on',
	'correlation_id',
	'causation_id',
	'global_position',
	'headers',
	'event_version',
]);

/**
 * Time zones in which a 3.x `TIMESTAMP` holds UTC, so that the conversion needs no `USING`, and no rewrite.
 */
const UTC_TIME_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu']);

/**
 * Work memory for the three window sorts of the numbering, and for the index builds.
 */
const WORK_MEM = '64MB';
const MAINTENANCE_WORK_MEM = '256MB';

/**
 * The key of the session advisory lock that keeps two migrations of the same table apart. Advisory locks are per
 * database, so the key names the table with its schema: the same pool in two schemas migrates in parallel.
 */
export const migrationLockKey = (table: string): string =>
	`hashtext('ocoda:migrate'), hashtext(format('%I.%I', current_schema(), ${escapeLiteral(table)}::text))`;

/**
 * The name of the temporary copy of an event table during its migration.
 */
export const copyTableName = (table: string): string =>
	`es_migrate_${createHash('sha256').update(table).digest('hex').slice(0, 12)}`;

const step = (name: StepName, statement: string, lock: string): PlannedStep => ({
	name,
	statement,
	lock,
	status: 'pending',
});

const baseReport = (inspection: CollectionInspection): CollectionPlan => {
	const report: CollectionPlan = {
		name: inspection.name,
		kind: inspection.kind,
		from: inspection.state,
		action: 'skip',
		rows: inspection.rows,
		gappedStreams: inspection.gappedStreams,
		steps: [],
		warnings: [],
		blocking: [],
	};
	if (inspection.bytes !== undefined) report.bytes = inspection.bytes;
	if (inspection.duplicateEventIds !== undefined) report.duplicateEventIds = inspection.duplicateEventIds;
	if (inspection.nonCrockfordEventIds !== undefined) report.nonCrockfordEventIds = inspection.nonCrockfordEventIds;
	if (inspection.snapshotFlags) report.snapshotFlags = inspection.snapshotFlags;
	const dependents = [
		...inspection.rewrites.map(({ name }) => `view or rule ${name}`),
		...inspection.triggers.map(
			({ name, events, enabled }) => `trigger ${name} (${events.join(', ')}${enabled ? '' : ', disabled'})`,
		),
		...inspection.publications.map((publication) => `publication ${publication}`),
		...inspection.referencingForeignKeys.map((foreignKey) => `foreign key ${foreignKey}`),
	];
	if (dependents.length > 0) report.dependents = dependents;
	return report;
};

/**
 * The steps before the transaction: the catalog (unless it exists) and the session lock against a second migration.
 */
const preamble = (inspection: CollectionInspection): PlannedStep[] => [
	...(inspection.table.catalog
		? []
		: [
				step(
					'create-catalog',
					`BEGIN; SELECT pg_advisory_xact_lock(hashtext(${escapeLiteral(`ocoda:${CATALOG}`)})); ${catalogStatement()}; COMMIT`,
					'none (a transaction of its own)',
				),
			]),
	step(
		'migration-lock',
		`SELECT pg_try_advisory_lock(${migrationLockKey(inspection.name)}) AS locked`,
		'advisory lock, for the session',
	),
];

const begin = (settings: PlanSettings): PlannedStep =>
	step(
		'begin',
		[
			'BEGIN ISOLATION LEVEL READ COMMITTED',
			`SET LOCAL lock_timeout = '${settings.lockTimeoutMs}ms'`,
			'SET LOCAL statement_timeout = 0',
			`SET LOCAL work_mem = '${WORK_MEM}'`,
			`SET LOCAL maintenance_work_mem = '${MAINTENANCE_WORK_MEM}'`,
		].join('; '),
		'none',
	);

const lockTable = (table: string): PlannedStep =>
	step('lock', `LOCK TABLE ${escapeIdentifier(table)} IN ACCESS EXCLUSIVE MODE`, 'ACCESS EXCLUSIVE');

const HELD = 'ACCESS EXCLUSIVE (held)';

/**
 * Why a table can't be migrated when PostgreSQL truncated its name: 3.x created the table of a pool whose name was too
 * long under the first 63 bytes of that name, and 4.x refuses such pools (`ensureCollection` throws).
 */
const truncatedName = ({ kind, name }: CollectionInspection): string | undefined => {
	const suffix = `-${kind}`;
	const pool = `a pool name of at most ${MAX_IDENTIFIER_BYTES - suffix.length} bytes ("<pool>${suffix}")`;
	const bytes = Buffer.byteLength(name);
	if (bytes > MAX_IDENTIFIER_BYTES) {
		return `The table name ${name} is ${bytes} bytes long: PostgreSQL truncated it to ${MAX_IDENTIFIER_BYTES} bytes when 3.x created the table, and 4.x refuses such pools. Rename the table for ${pool}, and use that pool.`;
	}
	if (name !== kind && !name.endsWith(suffix)) {
		return `${name} has the columns of a 3.x ${kind} table and a name that PostgreSQL truncated to ${MAX_IDENTIFIER_BYTES} bytes, which 4.x can't use. Rename the table for ${pool}, and use that pool.`;
	}
	return undefined;
};

/**
 * Why the current role can't migrate the table, and the objects that would keep the migration from dropping or
 * converting the columns it changes (views, rules, policies, triggers, publications, generated columns).
 */
const commonBlocking = (
	inspection: CollectionInspection,
	{ dropped = [], converted }: { dropped?: readonly string[]; converted: readonly string[] },
): string[] => {
	const blocking: string[] = [];
	if (!inspection.privileges.owner) {
		blocking.push(
			`The current role doesn't own ${inspection.name}: migrate as its owner (or a member of the owning role).`,
		);
	}
	if (!inspection.table.catalog && !inspection.privileges.createInSchema) {
		blocking.push(
			`The ${CATALOG} catalog doesn't exist, and the current role may not create tables in the current schema: create it first, or grant CREATE on the schema.`,
		);
	}
	if (inspection.table.catalog && !inspection.privileges.catalog) {
		blocking.push(
			`The current role may not read and write the ${CATALOG} catalog: grant it SELECT, INSERT and UPDATE on the catalog.`,
		);
	}
	const changed = [...dropped, ...converted];
	for (const { name, columns } of inspection.rewrites) {
		const used = columns.map((column) => column ?? '*');
		const affected = used.filter((column) => column === '*' || changed.includes(column));
		if (affected.length > 0) {
			blocking.push(
				`The view or rule ${name} uses ${affected.map((column) => (column === '*' ? 'the whole row' : column)).join(', ')}, which the migration changes: drop it before migrating and create it again afterwards.`,
			);
		}
	}
	for (const dependent of inspection.columnDependents) {
		const drops = dropped.includes(dependent.column);
		if ((drops && blocksDrop(dependent)) || (converted.includes(dependent.column) && blocksConversion(dependent))) {
			blocking.push(
				`The ${dependent.object} uses ${dependent.column}, which the migration ${drops ? 'drops' : 'converts to another type'}: drop it before migrating and create it again afterwards.`,
			);
		}
	}
	return blocking;
};

/**
 * Whether an object keeps a column from being dropped. Indexes, constraints and statistics of the table are dropped
 * with it (and reported); a generated column would be too, which loses a column of the user.
 */
const blocksDrop = ({ kind, normal }: ColumnDependent): boolean =>
	kind === 'generated column' ||
	kind === 'policy' ||
	kind === 'trigger' ||
	kind === 'publication' ||
	(kind === 'other' && normal);

/**
 * Whether an object keeps a column from getting another type. Indexes, constraints and statistics are rebuilt.
 */
const blocksConversion = ({ kind }: ColumnDependent): boolean =>
	kind !== 'index' && kind !== 'constraint' && kind !== 'statistics';

/**
 * A column name as the statements write it: quoted unless it is a column 3.x or 4.x creates.
 */
const eventColumn = (name: string): string => (KNOWN_EVENT_COLUMNS.has(name) ? name : escapeIdentifier(name));

/**
 * Plans the migration of an event table. A 3.x table is rewritten in place, in one transaction, which keeps its OID
 * (grants, publications and views that don't use the changed columns survive):
 *
 * 1. `number`: a temporary copy of the rows with their positions. Each row gets its rank `r` in 3.x's order
 *    `(event_date, event_id, stream_id, version)`; the rows are numbered by `(key, version)`, where `key` is the running
 *    maximum of `r` over the row's stream in version order, so every stream keeps its version order (ADR 0001 D33).
 * 2. `widen-columns`, `truncate`, `drop-event-date`: the v2 columns on the emptied table (`DROP COLUMN event_date`
 *    drops every index on it).
 * 3. `reinsert` in position order, `index-positions`, `register` (the counter is the highest position), `commit`.
 * 4. `vacuum`, after the commit; a failure is only a warning.
 */
export const planEventMigration = (inspection: CollectionInspection, settings: PlanSettings): CollectionPlan => {
	const report = baseReport(inspection);
	const { name, table, state } = inspection;
	const t = escapeIdentifier(name);

	if (state === 'absent') {
		return report;
	}
	const truncated = truncatedName(inspection);
	if (truncated) {
		report.action = 'blocked';
		report.blocking.push(truncated);
		return report;
	}

	if (state === 'v2') {
		const entry = table.entry;
		const registered =
			entry !== undefined &&
			entry.kind === 'events' &&
			entry.schemaVersion === SCHEMA_VERSION &&
			entry.lastPosition >= (inspection.maxPosition ?? 0n);
		if (!registered) {
			report.action = 'resume';
			report.steps = [
				...preamble(inspection).filter(({ name: stepName }) => stepName === 'create-catalog'),
				step('register', literalRegisterEventsStatement(name), 'the catalog row'),
			];
		}
		return report;
	}

	const widened = EVENT_TEXT_COLUMNS.filter((column) => table.columns[column] && table.columns[column].type !== 'text');
	report.blocking.push(...commonBlocking(inspection, { dropped: ['event_date'], converted: widened }));
	if (!table.columns.event_date) {
		report.blocking.push(
			`${name} has a partly migrated schema without event_date, which the positions are numbered by: restore it from a backup and migrate again.`,
		);
	}
	if (inspection.referencingForeignKeys.length > 0) {
		report.blocking.push(
			`The foreign keys ${inspection.referencingForeignKeys.join(', ')} reference ${name}, which the migration truncates and fills again: drop them before migrating and add them again afterwards.`,
		);
	}
	if (!inspection.privileges.temporary) {
		report.blocking.push(
			'The current role may not create temporary tables (TEMPORARY on the database), which hold the numbered copy.',
		);
	}

	// Every index on event_date, also through an expression or a predicate
	report.droppedIndexes = [
		...new Set([
			...table.indexes.filter(({ columns }) => columns.includes('event_date')).map(({ name: index }) => index),
			...inspection.columnDependents.flatMap(({ index, column }) =>
				index !== undefined && column === 'event_date' ? [index] : [],
			),
		]),
	].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	for (const { object } of inspection.columnDependents.filter(
		(dependent) => dependent.column === 'event_date' && dependent.kind !== 'index' && !blocksDrop(dependent),
	)) {
		report.warnings.push(`The migration drops ${object}, which uses event_date.`);
	}

	if (inspection.gappedStreams.total > 0) {
		report.warnings.push(
			`${inspection.gappedStreams.total} stream(s) have versions that don't run from 1 without gaps (see gappedStreams). They are migrated as they are, and conflict on their next append: append with their actual version as the expected version.`,
		);
	}
	if ((inspection.duplicateEventIds ?? 0) > 0) {
		report.warnings.push(
			`${inspection.duplicateEventIds} event id(s) are stored more than once; their events are numbered by stream id and version.`,
		);
	}
	for (const publication of inspection.publications) {
		report.warnings.push(
			`The publication ${publication} receives a TRUNCATE of ${name} followed by an INSERT of every row.`,
		);
	}
	for (const trigger of inspection.triggers.filter(({ enabled }) => enabled)) {
		if (trigger.events.includes('INSERT') || trigger.events.includes('TRUNCATE')) {
			report.warnings.push(
				`The trigger ${trigger.name} fires for the TRUNCATE and the re-inserted rows; disable it for the migration if it must not (ALTER TABLE ${t} DISABLE TRIGGER ${escapeIdentifier(trigger.name)}).`,
			);
		}
	}
	if (inspection.bytes !== undefined) {
		report.warnings.push(
			`Keep about ${formatBytes(Math.round(inspection.bytes * DISK_FACTOR))} of disk free for the migration (${DISK_FACTOR} times the table: the numbered copy and the sort files, part of them in temp_tablespaces, and the new table next to the old one until the commit). It writes about as much WAL as the table's size.`,
		);
	}

	report.action = report.blocking.length > 0 ? 'blocked' : state === 'v1' ? 'migrate' : 'resume';

	// Every column but event_date and the positions, also those a user added; generated columns are computed again
	const copied = Object.values(table.columns)
		.filter(({ name: column, generated }) => column !== 'event_date' && column !== 'global_position' && !generated)
		.map(({ name: column }) => eventColumn(column))
		.join(', ');
	const overriding = Object.values(table.columns).some(({ identity }) => identity) ? ' OVERRIDING SYSTEM VALUE' : '';
	const copyName = copyTableName(name);
	const copy = escapeIdentifier(copyName);
	const widen = [
		'ADD COLUMN IF NOT EXISTS global_position BIGINT',
		'ADD COLUMN IF NOT EXISTS headers JSONB',
		'ADD COLUMN IF NOT EXISTS event_version INTEGER',
		...widened.map((column) => `ALTER COLUMN ${column} TYPE TEXT`),
	];
	report.steps = [
		...preamble(inspection),
		begin(settings),
		lockTable(name),
		// The copy is written in the order of the positions (the last window sorts by them), which the reinsert keeps
		step(
			'number',
			`CREATE TEMPORARY TABLE ${copy} ON COMMIT DROP AS
SELECT ${copied}, row_number() OVER (ORDER BY stream_key, version) AS global_position
FROM (
	SELECT *, max(legacy_rank) OVER (PARTITION BY stream_id ORDER BY version ROWS UNBOUNDED PRECEDING) AS stream_key
	FROM (
		SELECT ${copied},
			row_number() OVER (ORDER BY event_date, event_id, stream_id, version) AS legacy_rank
		FROM ${t}
	) ranked
) keyed`,
			HELD,
		),
		step('widen-columns', `ALTER TABLE ${t} ${widen.join(', ')}`, HELD),
		// Refuses to empty the table outside the transaction of the numbered copy: statements run one by one in autocommit
		// would drop the copy at the end of its own statement, and lose the rows
		step(
			'truncate',
			`DO $migrate$
BEGIN
	IF to_regclass('pg_temp.${copyName}') IS NULL THEN
		RAISE EXCEPTION 'The numbered copy ${copyName} is missing: run the steps from begin to commit in one transaction';
	END IF;
	TRUNCATE ${t};
END $migrate$`,
			HELD,
		),
		step('drop-event-date', `ALTER TABLE ${t} ALTER COLUMN global_position SET NOT NULL, DROP COLUMN event_date`, HELD),
		step(
			'reinsert',
			`INSERT INTO ${t} (${copied}, global_position)${overriding}
SELECT ${copied}, global_position FROM ${copy}`,
			HELD,
		),
		step('index-positions', positionIndexStatement(name), HELD),
		step('register', literalRegisterEventsStatement(name), `${HELD}, the catalog row`),
		step('commit', 'COMMIT', 'released'),
		step('vacuum', `VACUUM (ANALYZE, PARALLEL 0) ${t}`, 'SHARE UPDATE EXCLUSIVE'),
	];
	return report;
};

/**
 * Plans the migration of a snapshot table, in place and in one transaction: the 3.x indexes on the latest flags are
 * dropped, the flags are normalized to one per stream on its highest version, the columns get their v2 types (a 3.x
 * `TIMESTAMP` `registered_on` is read in `legacyTimeZone`), and the unique partial index on the flags is created.
 */
export const planSnapshotMigration = (inspection: CollectionInspection, settings: PlanSettings): CollectionPlan => {
	const report = baseReport(inspection);
	report.gappedStreams = { total: 0, sample: [] };
	const { name, table, state } = inspection;
	const t = escapeIdentifier(name);

	if (state === 'absent') {
		return report;
	}
	const truncated = truncatedName(inspection);
	if (truncated) {
		report.action = 'blocked';
		report.blocking.push(truncated);
		return report;
	}

	if (state === 'v2') {
		const entry = table.entry;
		if (!entry || entry.kind !== 'snapshots' || entry.schemaVersion !== SCHEMA_VERSION) {
			report.action = 'resume';
			report.steps = [
				...preamble(inspection).filter(({ name: stepName }) => stepName === 'create-catalog'),
				step('register', literalRegisterSnapshotsStatement(name), 'the catalog row'),
			];
		}
		return report;
	}

	const widened = SNAPSHOT_TEXT_COLUMNS.filter(
		(column) => table.columns[column] && table.columns[column].type !== 'text',
	);
	const latest = table.columns.latest;
	const convertLatest = !latest || latest.type !== 'text' || latest.collation !== 'C';
	const convertRegisteredOn = table.columns.registered_on?.type !== 'timestamp with time zone';
	const altered = [...widened, ...(convertLatest ? ['latest'] : []), ...(convertRegisteredOn ? ['registered_on'] : [])];

	report.blocking.push(...commonBlocking(inspection, { converted: altered }));
	if (inspection.referencingForeignKeys.length > 0 && altered.includes('stream_id')) {
		report.blocking.push(
			`The foreign keys ${inspection.referencingForeignKeys.join(', ')} reference ${name}, whose key columns change type: drop them before migrating and add them again afterwards.`,
		);
	}

	const legacyIndexes = findLegacyLatestIndexes(table).map(({ name: index }) => index);
	report.droppedIndexes = legacyIndexes;

	const flags = inspection.snapshotFlags ?? { duplicateLatest: 0, missingLatest: 0 };
	if (flags.duplicateLatest > 0 || flags.missingLatest > 0) {
		report.warnings.push(
			`${flags.duplicateLatest} stream(s) have several snapshots flagged as the latest, and ${flags.missingLatest} stream(s) don't flag their highest version: the migration flags exactly the highest version of every stream.`,
		);
	}

	const utc = settings.timeZoneSql === undefined && UTC_TIME_ZONES.has(settings.legacyTimeZone);
	const zone = settings.timeZoneSql ?? escapeLiteral(settings.legacyTimeZone);
	if (convertRegisteredOn) {
		report.warnings.push(
			`registered_on holds the wall time of the 3.x processes, which is read in ${settings.timeZoneSql ?? settings.legacyTimeZone} (legacyTimeZone). Pass the time zone your 3.x instances ran in, if it was another one.`,
		);
		if (!utc && inspection.bytes !== undefined) {
			report.warnings.push(
				`Converting registered_on rewrites the table and its indexes under the lock: keep about ${formatBytes(inspection.bytes)} of disk free (the table's size). It writes about as much WAL.`,
			);
		}
	}

	const conversions = [
		...widened.map((column) => `ALTER COLUMN ${column} TYPE TEXT`),
		...(convertLatest ? ['ALTER COLUMN latest TYPE TEXT COLLATE "C"'] : []),
		...(convertRegisteredOn
			? [
					utc
						? 'ALTER COLUMN registered_on TYPE TIMESTAMPTZ'
						: `ALTER COLUMN registered_on TYPE TIMESTAMPTZ USING registered_on AT TIME ZONE ${zone}`,
				]
			: []),
	];

	report.action = report.blocking.length > 0 ? 'blocked' : state === 'v1' ? 'migrate' : 'resume';
	report.steps = [
		...preamble(inspection),
		begin(settings),
		lockTable(name),
		...(legacyIndexes.length > 0
			? [
					step(
						'drop-legacy-indexes',
						legacyIndexes.map((index) => `DROP INDEX ${escapeIdentifier(index)}`).join('; '),
						HELD,
					),
				]
			: []),
		step(
			'unflag',
			`UPDATE ${t} s SET latest = NULL
WHERE s.latest IS NOT NULL AND EXISTS (SELECT 1 FROM ${t} n WHERE n.stream_id = s.stream_id AND n.version > s.version)`,
			HELD,
		),
		step(
			'flag',
			`UPDATE ${t} s SET latest = 'latest#' || s.stream_id
WHERE s.latest IS DISTINCT FROM 'latest#' || s.stream_id
	AND NOT EXISTS (SELECT 1 FROM ${t} n WHERE n.stream_id = s.stream_id AND n.version > s.version)`,
			HELD,
		),
		...(conversions.length > 0
			? [
					step(
						'convert-columns',
						`${utc && convertRegisteredOn ? "SET LOCAL TimeZone = 'UTC'; " : ''}ALTER TABLE ${t} ${conversions.join(', ')}`,
						HELD,
					),
				]
			: []),
		step('index-latest', latestIndexStatement(name), HELD),
		step('register', literalRegisterSnapshotsStatement(name), `${HELD}, the catalog row`),
		step('commit', 'COMMIT', 'released'),
		step('vacuum', `VACUUM (ANALYZE, PARALLEL 0) ${t}`, 'SHARE UPDATE EXCLUSIVE'),
	];
	return report;
};

/**
 * How many times the size of an event table the migration may need in free disk, at its peak: until the commit, the
 * old files of the table stay next to the numbered copy and the new table and indexes, and the numbering spills its
 * sorts to disk. Measured at 2.2 to 2.6 times on 100,000 events.
 */
const DISK_FACTOR = 3;

const formatBytes = (bytes: number): string => {
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
