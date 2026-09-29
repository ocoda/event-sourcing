import { createHash } from 'node:crypto';
import type { MigrationCollectionReport, MigrationStep } from '@ocoda/event-sourcing';
import { escapeIdentifier, escapeLiteral } from 'pg';
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
import type { CollectionInspection } from './inspect.js';

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
 * The event columns that the numbered copy carries over: every 3.x column but `event_date`.
 */
const COPIED_EVENT_COLUMNS =
	'stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id';

/**
 * Time zones in which a 3.x `TIMESTAMP` holds UTC, so that the conversion needs no `USING`, and no rewrite.
 */
const UTC_TIME_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu']);

/**
 * Work memory for the sorts of the numbering (three window sorts and the ordered reinsert), and for the index builds.
 */
const WORK_MEM = '64MB';
const MAINTENANCE_WORK_MEM = '256MB';

/**
 * The key of the session advisory lock that keeps two migrations of the same table apart.
 */
export const migrationLockKey = (table: string): string =>
	`hashtext('ocoda:migrate'), hashtext(${escapeLiteral(table)})`;

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
					`SELECT pg_advisory_xact_lock(hashtext(${escapeLiteral(`ocoda:${CATALOG}`)})); ${catalogStatement()}`,
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
 * Why the current role can't migrate the table, and views or rules that the new column types would break.
 */
const commonBlocking = (inspection: CollectionInspection, alteredColumns: readonly string[]): string[] => {
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
	for (const { name, columns } of inspection.rewrites) {
		const used = columns.map((column) => column ?? '*');
		const affected = used.filter((column) => column === '*' || alteredColumns.includes(column));
		if (affected.length > 0) {
			blocking.push(
				`The view or rule ${name} uses ${affected.map((column) => (column === '*' ? 'the whole row' : column)).join(', ')}, which the migration changes: drop it before migrating and create it again afterwards.`,
			);
		}
	}
	return blocking;
};

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
	report.blocking.push(...commonBlocking(inspection, ['event_date', ...widened]));
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

	report.droppedIndexes = table.indexes
		.filter(({ columns }) => columns.includes('event_date'))
		.map(({ name: index }) => index);

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
			`The migration needs about ${formatBytes(Math.round(inspection.bytes * 2.2))} of free disk while it runs (2.2 times the table), part of it in temp_tablespaces, and writes about as much WAL as the table's size.`,
		);
	}

	report.action = report.blocking.length > 0 ? 'blocked' : state === 'v1' ? 'migrate' : 'resume';

	const copy = escapeIdentifier(copyTableName(name));
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
		step(
			'number',
			`CREATE TEMPORARY TABLE ${copy} ON COMMIT DROP AS
SELECT ${COPIED_EVENT_COLUMNS}, row_number() OVER (ORDER BY stream_key, version) AS global_position
FROM (
	SELECT *, max(legacy_rank) OVER (PARTITION BY stream_id ORDER BY version ROWS UNBOUNDED PRECEDING) AS stream_key
	FROM (
		SELECT ${COPIED_EVENT_COLUMNS},
			row_number() OVER (ORDER BY event_date, event_id, stream_id, version) AS legacy_rank
		FROM ${t}
	) ranked
) keyed`,
			HELD,
		),
		step('widen-columns', `ALTER TABLE ${t} ${widen.join(', ')}`, HELD),
		step('truncate', `TRUNCATE ${t}`, HELD),
		step('drop-event-date', `ALTER TABLE ${t} ALTER COLUMN global_position SET NOT NULL, DROP COLUMN event_date`, HELD),
		step(
			'reinsert',
			`INSERT INTO ${t} (${COPIED_EVENT_COLUMNS}, global_position)
SELECT ${COPIED_EVENT_COLUMNS}, global_position FROM ${copy} ORDER BY global_position`,
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

	report.blocking.push(...commonBlocking(inspection, altered));
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
