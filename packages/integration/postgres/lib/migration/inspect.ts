import type { MigrationGappedStream } from '@ocoda/event-sourcing';
import { escapeIdentifier } from 'pg';
import { MAX_IDENTIFIER_BYTES } from '../postgres.helpers.js';
import {
	CATALOG,
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

/**
 * An object that depends on a column of a table, other than a view or rule (`rewrites`) and a foreign key of another
 * table (`referencingForeignKeys`).
 */
export interface ColumnDependent {
	/** The object, as `pg_describe_object` names it (in the server's `lc_messages`). */
	object: string;
	kind: 'index' | 'constraint' | 'generated column' | 'policy' | 'trigger' | 'publication' | 'statistics' | 'other';
	/** The name of the index, when the object is one. */
	index?: string;
	/** The column it depends on. */
	column: string;
	/** A normal dependency, which keeps the column from being dropped; an automatic one is dropped with it. */
	normal: boolean;
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
	columnDependents: ColumnDependent[];
	privileges: {
		owner: boolean;
		createInSchema: boolean;
		temporary: boolean;
		/** Whether the role may read, insert and update the rows of the catalog; `true` when there is no catalog yet. */
		catalog: boolean;
	};
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
 * `<pool>-events`, `snapshots` or `<pool>-snapshots`), in binary order of their names. Tables with the columns and a
 * name of exactly 63 bytes are included too: 3.x created them for pools whose table name PostgreSQL truncated, and the
 * migration reports them as blocked.
 */
export const discoverCollections = async (connection: Queryable, kind: CollectionKind): Promise<string[]> => {
	const { rows } = await connection.query<{ name: string }>(
		`SELECT c.relname AS name
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
			AND (c.relname = $1 OR right(c.relname, length($1) + 1) = '-' || $1 OR octet_length(c.relname) = $3)
			AND (
				SELECT count(*) FROM pg_attribute a
				WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY ($2::text[])
			) = cardinality($2::text[])
		ORDER BY c.relname COLLATE "C"`,
		[kind, SHAPES[kind], MAX_IDENTIFIER_BYTES],
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
	// The catalog row is only read when the role may read the catalog: otherwise the plan is blocked
	const {
		rows: [privileges],
	} = await connection.query<{ create_in_schema: boolean; temporary: boolean; catalog: boolean }>(
		`SELECT has_schema_privilege(current_schema(), 'CREATE') AS create_in_schema,
			has_database_privilege(current_database(), 'TEMPORARY') AS temporary,
			(SELECT r IS NULL OR (has_table_privilege(r, 'SELECT') AND has_table_privilege(r, 'INSERT')
				AND has_table_privilege(r, 'UPDATE'))
			FROM to_regclass(format('%I.%I', current_schema(), $1::text)) AS r) AS catalog`,
		[CATALOG],
	);

	const table = await describeTable(connection, name, { entry: privileges.catalog });
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
		columnDependents: [],
		privileges: {
			owner: false,
			createInSchema: privileges.create_in_schema,
			temporary: privileges.temporary,
			catalog: privileges.catalog,
		},
	};

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

	// A generated column depends on the columns of its expression: through the column itself up to PostgreSQL 14 (and
	// DROP COLUMN drops it too), through its expression from 15 on (and DROP COLUMN fails). Internal dependencies (the
	// primary key index on its constraint, an expression on its column) aren't listed.
	const { rows: columnDependents } = await connection.query<{
		object: string;
		kind: ColumnDependent['kind'];
		index: string | null;
		column: string;
		normal: boolean;
	}>(
		`SELECT CASE
				WHEN ad.oid IS NOT NULL THEN pg_describe_object('pg_class'::regclass, ad.adrelid, ad.adnum)
				ELSE pg_describe_object(d.classid, d.objid, d.objsubid)
			END AS object,
			CASE
				WHEN ad.oid IS NOT NULL OR (d.classid = 'pg_class'::regclass AND d.objsubid > 0) THEN 'generated column'
				WHEN d.classid = 'pg_class'::regclass AND c.relkind IN ('i', 'I') THEN 'index'
				WHEN d.classid = 'pg_constraint'::regclass THEN 'constraint'
				WHEN d.classid = 'pg_policy'::regclass THEN 'policy'
				WHEN d.classid = 'pg_trigger'::regclass THEN 'trigger'
				WHEN d.classid = 'pg_publication_rel'::regclass THEN 'publication'
				WHEN d.classid = 'pg_statistic_ext'::regclass THEN 'statistics'
				ELSE 'other'
			END AS kind,
			CASE WHEN c.relkind IN ('i', 'I') THEN c.relname::text END AS index,
			a.attname::text AS column, bool_or(d.deptype = 'n') AS normal
		FROM pg_depend d
		JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
		LEFT JOIN pg_class c ON d.classid = 'pg_class'::regclass AND c.oid = d.objid
		LEFT JOIN pg_constraint con ON d.classid = 'pg_constraint'::regclass AND con.oid = d.objid
		LEFT JOIN pg_attrdef ad ON d.classid = 'pg_attrdef'::regclass AND ad.oid = d.objid
		WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = $1::oid AND d.refobjsubid > 0 AND d.deptype IN ('n', 'a')
			AND d.classid <> 'pg_rewrite'::regclass
			AND (con.oid IS NULL OR con.conrelid = $1::oid)
		GROUP BY 1, 2, 3, 4
		ORDER BY 1, 4`,
		[oid],
	);
	inspection.columnDependents = columnDependents.map(({ object, kind: dependentKind, index, column, normal }) => ({
		object,
		kind: dependentKind,
		...(index === null ? {} : { index }),
		column,
		normal,
	}));

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
