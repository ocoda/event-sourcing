import { type Pool, type PoolClient, escapeIdentifier, escapeLiteral } from 'pg';
import { MAX_IDENTIFIER_BYTES, deriveIndexName, withTransaction } from './postgres.helpers.js';

// Schema v2 (ADR 0002 §1, §2): the catalog, the event and snapshot tables, and how the stores recognize them.

/**
 * Something that runs a query: the pool, or a client in a transaction.
 */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * The catalog of a schema: one row per collection (table), which registers its kind and schema version, and holds the
 * counter of the global positions of an event collection. `listCollections` reads it.
 */
export const CATALOG = 'event_sourcing_collections';

/**
 * The key of the advisory lock that serializes the creation of the catalog, so that two stores that create it at the
 * same time don't race on `pg_type`.
 */
const CATALOG_LOCK_KEY = `ocoda:${CATALOG}`;

/**
 * The schema version of the event and snapshot tables this driver creates.
 */
export const SCHEMA_VERSION = 2;

export type CollectionState = 'absent' | 'v1' | 'v1-partial' | 'v2';

export const catalogStatement = (): string =>
	`CREATE TABLE IF NOT EXISTS ${CATALOG} (
	name TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('events', 'snapshots')),
	schema_version INTEGER NOT NULL,
	last_position BIGINT NOT NULL DEFAULT 0 CHECK (last_position >= 0)
) WITH (fillfactor = 50)`;

/**
 * The name of the unique index on the global positions of an event table.
 */
export const positionIndexName = (table: string): string => deriveIndexName(table, 'global_position');

/**
 * The name of the unique partial index on the latest flags of a snapshot table.
 */
export const latestIndexName = (table: string): string => deriveIndexName(table, 'latest');

export const positionIndexStatement = (table: string): string =>
	`CREATE UNIQUE INDEX IF NOT EXISTS ${escapeIdentifier(positionIndexName(table))} ON ${escapeIdentifier(table)} (global_position)`;

export const latestIndexStatement = (table: string): string =>
	`CREATE UNIQUE INDEX IF NOT EXISTS ${escapeIdentifier(latestIndexName(table))} ON ${escapeIdentifier(table)} (aggregate_name, latest) WHERE latest IS NOT NULL`;

/**
 * The statements that create a v2 event table. The columns that 3.x doesn't have come last, so that a created table and
 * a migrated one have the same columns in the same order.
 */
export const eventTableStatements = (table: string): string[] => [
	`CREATE TABLE IF NOT EXISTS ${escapeIdentifier(table)} (
	stream_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	event TEXT NOT NULL,
	payload JSONB NOT NULL,
	event_id TEXT NOT NULL,
	aggregate_id TEXT NOT NULL,
	occurred_on TIMESTAMPTZ NOT NULL,
	correlation_id TEXT,
	causation_id TEXT,
	global_position BIGINT NOT NULL,
	headers JSONB,
	event_version INTEGER,
	PRIMARY KEY (stream_id, version)
)`,
	positionIndexStatement(table),
];

/**
 * The statements that create a v2 snapshot table. `latest` compares bytes (`COLLATE "C"`), so that the aggregate cursor
 * of `getLastEnvelopesForAggregate` pages in binary order.
 */
export const snapshotTableStatements = (table: string): string[] => [
	`CREATE TABLE IF NOT EXISTS ${escapeIdentifier(table)} (
	stream_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	payload JSONB NOT NULL,
	snapshot_id TEXT NOT NULL,
	aggregate_id TEXT NOT NULL,
	registered_on TIMESTAMPTZ NOT NULL,
	aggregate_name TEXT NOT NULL,
	latest TEXT COLLATE "C",
	PRIMARY KEY (stream_id, version)
)`,
	latestIndexStatement(table),
];

/**
 * Registers an event table in the catalog, or heals its counter: the counter is set to the highest position of the
 * table when it is behind, and never decreases, so that a pool that was dropped and created again doesn't reuse
 * positions. Writes nothing when the row is up to date.
 */
export const registerEventsStatement = (table: string, name = '$1'): string =>
	`INSERT INTO ${CATALOG} (name, kind, schema_version, last_position)
VALUES (${name}, 'events', ${SCHEMA_VERSION}, (SELECT COALESCE(MAX(global_position), 0) FROM ${escapeIdentifier(table)}))
ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, schema_version = EXCLUDED.schema_version,
	last_position = GREATEST(${CATALOG}.last_position, EXCLUDED.last_position)
WHERE ${CATALOG}.kind <> EXCLUDED.kind OR ${CATALOG}.schema_version <> EXCLUDED.schema_version
	OR ${CATALOG}.last_position < EXCLUDED.last_position`;

/**
 * Registers a snapshot table in the catalog with its schema version (1 for a 3.x table that wasn't migrated).
 */
export const registerSnapshotsStatement = (name = '$1', schemaVersion = '$2'): string =>
	`INSERT INTO ${CATALOG} (name, kind, schema_version)
VALUES (${name}, 'snapshots', ${schemaVersion})
ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, schema_version = EXCLUDED.schema_version
WHERE ${CATALOG}.kind <> EXCLUDED.kind OR ${CATALOG}.schema_version <> EXCLUDED.schema_version`;

/**
 * The registration statements with the table name as a literal, for the statements a dry run prints.
 */
export const literalRegisterEventsStatement = (table: string): string =>
	registerEventsStatement(table, escapeLiteral(table));
export const literalRegisterSnapshotsStatement = (table: string): string =>
	registerSnapshotsStatement(escapeLiteral(table), String(SCHEMA_VERSION));

/**
 * Throws when the name of a table doesn't fit in a Postgres identifier, which Postgres would silently truncate.
 */
export const assertTableName = (table: string): void => {
	const bytes = Buffer.byteLength(table);
	if (bytes > MAX_IDENTIFIER_BYTES) {
		throw new RangeError(
			`The table name ${JSON.stringify(table)} is ${bytes} bytes long, Postgres identifiers are at most ${MAX_IDENTIFIER_BYTES}: use a shorter pool name`,
		);
	}
};

/**
 * Whether the catalog exists in the current schema.
 */
export const catalogExists = async (connection: Queryable): Promise<boolean> => {
	const { rows } = await connection.query<{ exists: boolean }>(
		`SELECT to_regclass(format('%I.%I', current_schema(), $1::text)) IS NOT NULL AS exists`,
		[CATALOG],
	);
	return rows[0].exists;
};

/**
 * Creates the catalog unless it exists. With `create: false`, only reports whether it exists.
 */
export const ensureCatalog = async (pool: Pool, create: boolean): Promise<boolean> => {
	if (await catalogExists(pool)) {
		return true;
	}
	if (!create) {
		return false;
	}
	await withTransaction(pool, async (client) => {
		await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CATALOG_LOCK_KEY]);
		await client.query(catalogStatement());
	});
	return true;
};

export interface ColumnInfo {
	name: string;
	type: string;
	notNull: boolean;
	/** The collation of a text column: `default`, `C`, ... */
	collation: string | null;
}

export interface IndexInfo {
	name: string;
	unique: boolean;
	primary: boolean;
	valid: boolean;
	/** A partial index (`WHERE …`). */
	partial: boolean;
	/** An index on columns only, without expressions. */
	plain: boolean;
	method: string;
	/** The key columns, in order. */
	columns: string[];
}

export interface CatalogEntry {
	kind: 'events' | 'snapshots';
	schemaVersion: number;
	lastPosition: bigint;
}

export interface TableInfo {
	oid: number | null;
	columns: Record<string, ColumnInfo>;
	indexes: IndexInfo[];
	/** The catalog row of the table; `undefined` when it has none, or there is no catalog. */
	entry?: CatalogEntry;
	catalog: boolean;
}

/**
 * Reads the columns, the indexes and the catalog row of a table of the current schema.
 */
export const describeTable = async (connection: Queryable, table: string): Promise<TableInfo> => {
	const {
		rows: [{ oid, catalog }],
	} = await connection.query<{ oid: number | null; catalog: boolean }>(
		`SELECT c.oid, to_regclass(format('%I.%I', current_schema(), $2::text)) IS NOT NULL AS catalog
		FROM (SELECT to_regclass(format('%I.%I', current_schema(), $1::text)) AS regclass) r
		LEFT JOIN pg_class c ON c.oid = r.regclass AND c.relkind IN ('r', 'p')`,
		[table, CATALOG],
	);

	let entry: CatalogEntry | undefined;
	if (catalog) {
		const { rows } = await connection.query<{
			kind: CatalogEntry['kind'];
			schema_version: number;
			last_position: string;
		}>(`SELECT kind, schema_version, last_position::text AS last_position FROM ${CATALOG} WHERE name = $1`, [table]);
		if (rows[0]) {
			entry = {
				kind: rows[0].kind,
				schemaVersion: rows[0].schema_version,
				lastPosition: BigInt(rows[0].last_position),
			};
		}
	}

	if (oid === null) {
		return { oid, columns: {}, indexes: [], entry, catalog };
	}

	const { rows: columnRows } = await connection.query<{
		name: string;
		type: string;
		not_null: boolean;
		collation: string | null;
	}>(
		`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
			co.collname AS collation
		FROM pg_attribute a
		LEFT JOIN pg_collation co ON co.oid = a.attcollation
		WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`,
		[oid],
	);
	const { rows: indexRows } = await connection.query<{
		name: string;
		unique: boolean;
		primary: boolean;
		valid: boolean;
		partial: boolean;
		plain: boolean;
		method: string;
		columns: string[];
	}>(
		`SELECT ic.relname AS name, i.indisunique AS unique, i.indisprimary AS primary, i.indisvalid AS valid,
			i.indpred IS NOT NULL AS partial, i.indexprs IS NULL AS plain, am.amname AS method,
			array(
				SELECT a.attname::text
				FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ordinality)
				JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
				WHERE k.ordinality <= i.indnkeyatts
				ORDER BY k.ordinality
			) AS columns
		FROM pg_index i
		JOIN pg_class ic ON ic.oid = i.indexrelid
		JOIN pg_am am ON am.oid = ic.relam
		WHERE i.indrelid = $1
		ORDER BY ic.relname COLLATE "C"`,
		[oid],
	);

	return {
		oid,
		columns: Object.fromEntries(
			columnRows.map(({ name, type, not_null, collation }) => [name, { name, type, notNull: not_null, collation }]),
		),
		indexes: indexRows,
		entry,
		catalog,
	};
};

const hasColumns = (index: IndexInfo, columns: readonly string[]): boolean =>
	index.plain && index.columns.length === columns.length && index.columns.every((column, i) => column === columns[i]);

/**
 * The valid, non-partial unique index on `global_position`, whatever its name.
 */
export const findPositionIndex = ({ indexes }: TableInfo): IndexInfo | undefined =>
	indexes.find((index) => index.unique && index.valid && !index.partial && hasColumns(index, ['global_position']));

/**
 * The valid unique index on `(aggregate_name, latest)`, whatever its name.
 */
export const findLatestIndex = ({ indexes }: TableInfo): IndexInfo | undefined =>
	indexes.find((index) => index.unique && index.valid && hasColumns(index, ['aggregate_name', 'latest']));

/**
 * The indexes on `(aggregate_name, latest)` that 3.x created: not unique, whatever their name (3.0.0 used a fixed
 * name, later versions derive it from the table name).
 */
export const findLegacyLatestIndexes = ({ indexes }: TableInfo): IndexInfo[] =>
	indexes.filter((index) => !index.unique && hasColumns(index, ['aggregate_name', 'latest']));

/**
 * The state of an event table, by its columns (never by its index names):
 * - `v2`: a `NOT NULL` `global_position` and no `event_date`;
 * - `v1`: an `event_date` and no `global_position` (3.x);
 * - `v1-partial`: anything else.
 */
export const eventTableState = ({ oid, columns }: TableInfo): CollectionState => {
	if (oid === null) {
		return 'absent';
	}
	const position = columns.global_position;
	const eventDate = columns.event_date;
	if (position?.notNull && !eventDate) {
		return 'v2';
	}
	if (eventDate && !position) {
		return 'v1';
	}
	return 'v1-partial';
};

/**
 * The state of a snapshot table:
 * - `v2`: a `TIMESTAMPTZ` `registered_on` and a unique index on the latest flags;
 * - `v1`: a `TIMESTAMP` `registered_on` and no such index (3.x);
 * - `v1-partial`: anything else.
 */
export const snapshotTableState = (table: TableInfo): CollectionState => {
	if (table.oid === null) {
		return 'absent';
	}
	const zoned = table.columns.registered_on?.type === 'timestamp with time zone';
	const unique = findLatestIndex(table) !== undefined;
	if (zoned && unique) {
		return 'v2';
	}
	if (table.columns.registered_on && !zoned && !unique) {
		return 'v1';
	}
	return 'v1-partial';
};

/**
 * Renders statements the way a DBA would run them.
 */
export const renderStatements = (statements: readonly string[]): string =>
	statements.map((statement) => `${statement};`).join('\n');
