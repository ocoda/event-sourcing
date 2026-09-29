import type { MigrationGappedStream } from '@ocoda/event-sourcing';
import { escapeIdentifier } from 'pg';
import {
	type CollectionState,
	type Queryable,
	type TableInfo,
	describeTable,
	eventTableState,
	snapshotTableState,
} from '../postgres.schema.js';

// What migrate() reads from the database before it plans anything. Nothing here writes.

export type CollectionKind = 'events' | 'snapshots';

/**
 * A view, or a rule, that depends on a table, with the columns it uses (`null` for a dependency on the whole row).
 */
export interface DependentRewrite {
	name: string;
	columns: (string | null)[];
}

export interface TriggerInfo {
	name: string;
	events: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
	enabled: boolean;
}

export interface CollectionInspection {
	kind: CollectionKind;
	name: string;
	table: TableInfo;
	state: CollectionState;
	rows: number;
	bytes?: number;
	/** v2 event tables: the highest stored position. */
	maxPosition?: bigint;
	gappedStreams: { total: number; sample: MigrationGappedStream[] };
	duplicateEventIds?: number;
	nonCrockfordEventIds?: number;
	snapshotFlags?: { duplicateLatest: number; missingLatest: number };
	rewrites: DependentRewrite[];
	triggers: TriggerInfo[];
	publications: string[];
	/** Foreign keys of other tables that reference this one. */
	referencingForeignKeys: string[];
	privileges: { owner: boolean; createInSchema: boolean; temporary: boolean };
}

/**
 * The columns a table of each kind has in every schema version, by which `migrate()` recognizes one.
 */
const SHAPES: Record<CollectionKind, string[]> = {
	events: ['stream_id', 'version', 'event', 'payload', 'event_id', 'aggregate_id', 'occurred_on'],
	snapshots: [
		'stream_id',
		'version',
		'payload',
		'snapshot_id',
		'aggregate_id',
		'registered_on',
		'aggregate_name',
		'latest',
	],
};

/**
 * The tables of the current schema that have the name and the columns of a collection of the given kind (`events` or
 * `<pool>-events`, `snapshots` or `<pool>-snapshots`), in binary order of their names.
 */
export const discoverCollections = async (connection: Queryable, kind: CollectionKind): Promise<string[]> => {
	const { rows } = await connection.query<{ name: string }>(
		`SELECT c.relname AS name
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
			AND (c.relname = $1 OR right(c.relname, length($1) + 1) = '-' || $1)
			AND (
				SELECT count(*) FROM pg_attribute a
				WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY ($2::text[])
			) = cardinality($2::text[])
		ORDER BY c.relname COLLATE "C"`,
		[kind, SHAPES[kind]],
	);
	return rows.map(({ name }) => name);
};

const TRIGGER_EVENTS: [number, TriggerInfo['events'][number]][] = [
	[1 << 2, 'INSERT'],
	[1 << 3, 'DELETE'],
	[1 << 4, 'UPDATE'],
	[1 << 5, 'TRUNCATE'],
];

/**
 * Reads what `migrate()` needs to know about a table: its state and columns, what depends on it, what the current role
 * may do, and the facts the report shows (rows, gapped streams, duplicate ids, snapshot flags).
 */
export const inspectCollection = async (
	connection: Queryable,
	kind: CollectionKind,
	name: string,
): Promise<CollectionInspection> => {
	const table = await describeTable(connection, name);
	const state = kind === 'events' ? eventTableState(table) : snapshotTableState(table);
	const inspection: CollectionInspection = {
		kind,
		name,
		table,
		state,
		rows: 0,
		gappedStreams: { total: 0, sample: [] },
		rewrites: [],
		triggers: [],
		publications: [],
		referencingForeignKeys: [],
		privileges: { owner: false, createInSchema: false, temporary: false },
	};

	const {
		rows: [privileges],
	} = await connection.query<{ create_in_schema: boolean; temporary: boolean }>(
		`SELECT has_schema_privilege(current_schema(), 'CREATE') AS create_in_schema,
			has_database_privilege(current_database(), 'TEMPORARY') AS temporary`,
	);
	inspection.privileges.createInSchema = privileges.create_in_schema;
	inspection.privileges.temporary = privileges.temporary;

	if (table.oid === null) {
		return inspection;
	}
	const oid = table.oid;
	const t = escapeIdentifier(name);

	const {
		rows: [facts],
	} = await connection.query<{ rows: string; bytes: string; owner: boolean }>(
		`SELECT (SELECT count(*) FROM ${t})::text AS rows, pg_total_relation_size($1::oid)::text AS bytes,
			pg_has_role(current_user, c.relowner, 'USAGE') AS owner
		FROM pg_class c WHERE c.oid = $1::oid`,
		[oid],
	);
	inspection.rows = Number(facts.rows);
	inspection.bytes = Number(facts.bytes);
	inspection.privileges.owner = facts.owner;

	const { rows: rewrites } = await connection.query<{ name: string; columns: (string | null)[] }>(
		`SELECT dependent.oid::regclass::text || CASE WHEN r.rulename = '_RETURN' THEN '' ELSE ' (rule ' || r.rulename || ')' END AS name,
			array_agg(DISTINCT a.attname::text) AS columns
		FROM pg_depend d
		JOIN pg_rewrite r ON r.oid = d.objid
		JOIN pg_class dependent ON dependent.oid = r.ev_class
		LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid AND d.refobjsubid > 0
		WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = $1::oid
		GROUP BY 1
		ORDER BY 1`,
		[oid],
	);
	inspection.rewrites = rewrites;

	const { rows: triggers } = await connection.query<{ name: string; type: number; enabled: boolean }>(
		`SELECT tgname AS name, tgtype::int AS type, tgenabled <> 'D' AS enabled
		FROM pg_trigger WHERE tgrelid = $1::oid AND NOT tgisinternal ORDER BY tgname`,
		[oid],
	);
	inspection.triggers = triggers.map(({ name: trigger, type, enabled }) => ({
		name: trigger,
		events: TRIGGER_EVENTS.filter(([bit]) => (type & bit) !== 0).map(([, event]) => event),
		enabled,
	}));

	const { rows: publications } = await connection.query<{ name: string }>(
		`SELECT pubname AS name FROM pg_publication_tables
		WHERE schemaname = current_schema() AND tablename = $1 ORDER BY pubname`,
		[name],
	);
	inspection.publications = publications.map(({ name: publication }) => publication);

	const { rows: foreignKeys } = await connection.query<{ name: string }>(
		`SELECT conrelid::regclass::text || '.' || conname AS name FROM pg_constraint
		WHERE confrelid = $1::oid AND contype = 'f' AND conrelid <> $1::oid ORDER BY 1`,
		[oid],
	);
	inspection.referencingForeignKeys = foreignKeys.map(({ name: foreignKey }) => foreignKey);

	if (kind === 'events') {
		await inspectEvents(connection, inspection);
	} else {
		await inspectSnapshots(connection, inspection);
	}
	return inspection;
};

const inspectEvents = async (connection: Queryable, inspection: CollectionInspection): Promise<void> => {
	const t = escapeIdentifier(inspection.name);
	const gapped = `SELECT stream_id, count(*)::int AS events, min(version) AS min_version, max(version) AS max_version
		FROM ${t} GROUP BY stream_id HAVING min(version) <> 1 OR max(version) <> count(*)`;

	const { rows: sample } = await connection.query<{
		stream_id: string;
		events: number;
		min_version: number;
		max_version: number;
	}>(`${gapped} ORDER BY stream_id COLLATE "C" LIMIT 1000`);
	const {
		rows: [counts],
	} = await connection.query<{ gapped: number; duplicate_ids: number; non_crockford: number }>(
		`SELECT (SELECT count(*)::int FROM (${gapped}) g) AS gapped,
			(SELECT count(*)::int FROM (SELECT 1 FROM ${t} GROUP BY event_id HAVING count(*) > 1) d) AS duplicate_ids,
			(SELECT count(*)::int FROM ${t} WHERE event_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$') AS non_crockford`,
	);
	inspection.gappedStreams = {
		total: counts.gapped,
		sample: sample.map((row) => ({
			streamId: row.stream_id,
			events: row.events,
			minVersion: row.min_version,
			maxVersion: row.max_version,
		})),
	};
	inspection.duplicateEventIds = counts.duplicate_ids;
	inspection.nonCrockfordEventIds = counts.non_crockford;

	if (inspection.table.columns.global_position) {
		const {
			rows: [{ max }],
		} = await connection.query<{ max: string | null }>(`SELECT max(global_position)::text AS max FROM ${t}`);
		inspection.maxPosition = BigInt(max ?? '0');
	}
};

const inspectSnapshots = async (connection: Queryable, inspection: CollectionInspection): Promise<void> => {
	const t = escapeIdentifier(inspection.name);
	const {
		rows: [flags],
	} = await connection.query<{ duplicate_latest: number; missing_latest: number }>(
		`SELECT
			(SELECT count(*)::int FROM (SELECT 1 FROM ${t} WHERE latest IS NOT NULL GROUP BY stream_id HAVING count(*) > 1) d)
				AS duplicate_latest,
			(SELECT count(*)::int FROM ${t} s
				WHERE NOT EXISTS (SELECT 1 FROM ${t} n WHERE n.stream_id = s.stream_id AND n.version > s.version)
				AND s.latest IS DISTINCT FROM 'latest#' || s.stream_id) AS missing_latest`,
	);
	inspection.snapshotFlags = { duplicateLatest: flags.duplicate_latest, missingLatest: flags.missing_latest };
};
