import { createHash } from 'node:crypto';

/**
 * Schema v2 of the MariaDB stores (ADR 0002 §1 and §3): the catalog, the DDL of the event and snapshot tables, and the
 * inspection that tells a 3.x table from a 4.0 one.
 */

/**
 * The catalog: one row per event or snapshot table of the database, with the table's schema version and, for event
 * tables, the counter of its global positions. `listCollections` reads it.
 */
export const CATALOG_TABLE = 'event_sourcing_collections';

/** The longest table name MariaDB accepts. */
export const MAX_TABLE_NAME_LENGTH = 64;

/** The suffix of the backup a migration keeps of a 3.x event table (`<t>__es_v1`). */
export const BACKUP_SUFFIX = '__es_v1';

/** The suffix of the copy a migration fills before it swaps it in (`<t>__es_v2`). */
export const COPY_SUFFIX = '__es_v2';

/** The unique index on the global position of an event table. */
export const GLOBAL_POSITION_INDEX = 'ux_global_position';

/** The unique index on the latest flag of a snapshot table. */
export const LATEST_INDEX = 'ux_latest';

/** Anything that runs a query: a pool or a connection. */
export interface Queryable {
	// oxlint-disable-next-line typescript/no-explicit-any -- the connector's own signature
	query<T = any>(sql: string, values?: unknown): Promise<T>;
}

/**
 * Quotes an identifier for MariaDB, like the connector's `escapeId`.
 * @throws Error for an empty name, or one with a NUL character
 */
export const escapeId = (name: string): string => {
	if (!name) {
		throw new Error('Cannot escape an empty identifier');
	}
	if (name.includes('\u0000')) {
		throw new Error('Cannot escape an identifier with a NUL character');
	}
	return `\`${name.replaceAll('`', '``')}\``;
};

/**
 * Quotes a string literal. With `NO_BACKSLASH_ESCAPES` in the session's `sql_mode`, a backslash is an ordinary
 * character and must not be doubled.
 */
export const escapeString = (value: string, noBackslashEscapes = false): string => {
	if (value.includes('\u0000')) {
		throw new Error('Cannot quote a string with a NUL character');
	}
	const escaped = noBackslashEscapes ? value : value.replaceAll('\\', '\\\\');
	return `'${escaped.replaceAll("'", "''")}'`;
};

/**
 * Checks that a table name fits MariaDB's limit, rather than failing on a truncated or refused name later.
 * @throws RangeError when it doesn't
 */
export const assertTableName = (table: string): void => {
	if (table.length > MAX_TABLE_NAME_LENGTH) {
		throw new RangeError(
			`The table name ${table} has ${table.length} characters, MariaDB allows ${MAX_TABLE_NAME_LENGTH}: use a shorter pool name`,
		);
	}
	escapeId(table);
};

/**
 * The name of a table the migration derives from a table: `<table><suffix>`, or, when that exceeds 64 characters, the
 * first characters of the table name, a hash of the whole name, and the suffix.
 */
export const derivedTableName = (table: string, suffix: string): string => {
	const name = `${table}${suffix}`;
	if (name.length <= MAX_TABLE_NAME_LENGTH) {
		return name;
	}
	const hash = createHash('sha256').update(table).digest('hex').slice(0, 8);
	const prefix = [...table].slice(0, MAX_TABLE_NAME_LENGTH - suffix.length - hash.length - 1).join('');
	return `${prefix}_${hash}${suffix}`;
};

export const backupTableName = (table: string): string => derivedTableName(table, BACKUP_SUFFIX);
export const copyTableName = (table: string): string => derivedTableName(table, COPY_SUFFIX);

/** Whether a table name is a backup or a copy of the migration. */
export const isMigrationTable = (table: string): boolean =>
	table.endsWith(BACKUP_SUFFIX) || table.endsWith(COPY_SUFFIX);

/** The DDL of the catalog. */
export const catalogDdl = (): string =>
	`CREATE TABLE IF NOT EXISTS ${escapeId(CATALOG_TABLE)} (
  name VARCHAR(64) NOT NULL PRIMARY KEY,
  kind ENUM('events', 'snapshots') NOT NULL,
  schema_version SMALLINT NOT NULL,
  last_position BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

/**
 * The DDL of an event table. The 3.x columns come first, then `global_position`, `headers` and `event_version`, so
 * that created and migrated tables are the same.
 */
export const eventTableDdl = (table: string, { ifNotExists = true } = {}): string =>
	`CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${escapeId(table)} (
  stream_id VARCHAR(255) NOT NULL,
  version INT NOT NULL,
  event VARCHAR(255) NOT NULL,
  payload JSON NOT NULL,
  event_id VARCHAR(40) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,
  occurred_on DATETIME(3) NOT NULL,
  correlation_id VARCHAR(255) NULL,
  causation_id VARCHAR(255) NULL,
  global_position BIGINT NOT NULL,
  headers JSON NULL,
  event_version INT NULL,
  PRIMARY KEY (stream_id, version),
  UNIQUE KEY ${GLOBAL_POSITION_INDEX} (global_position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

/**
 * The DDL of a snapshot table. Its columns are the 3.x columns, in the 3.x order. The unique index on
 * `(aggregate_name, latest)` allows one flagged snapshot per stream: unflagged snapshots have a `NULL` latest, and
 * `NULL`s are distinct.
 */
export const snapshotTableDdl = (table: string): string =>
	`CREATE TABLE IF NOT EXISTS ${escapeId(table)} (
  stream_id VARCHAR(255) NOT NULL,
  version INT NOT NULL,
  payload JSON NOT NULL,
  snapshot_id VARCHAR(40) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,
  registered_on DATETIME(3) NOT NULL,
  aggregate_name VARCHAR(255) NOT NULL,
  latest VARCHAR(270) NULL,
  PRIMARY KEY (stream_id, version),
  UNIQUE KEY ${LATEST_INDEX} (aggregate_name, latest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

/**
 * Registers an event table in the catalog, or heals its counter: the counter never decreases, and is at least the
 * highest position of the table.
 */
export const registerEventTableSql = (table: string, noBackslashEscapes = false): string =>
	`INSERT INTO ${escapeId(CATALOG_TABLE)} (name, kind, schema_version, last_position)
  SELECT ${escapeString(table, noBackslashEscapes)}, 'events', 2, COALESCE(MAX(global_position), 0) FROM ${escapeId(table)}
  ON DUPLICATE KEY UPDATE schema_version = 2, last_position = GREATEST(last_position, VALUES(last_position))`;

/** Registers a snapshot table in the catalog, with the version of its schema. */
export const registerSnapshotTableSql = (table: string, schemaVersion: 1 | 2, noBackslashEscapes = false): string =>
	`INSERT INTO ${escapeId(CATALOG_TABLE)} (name, kind, schema_version, last_position)
  VALUES (${escapeString(table, noBackslashEscapes)}, 'snapshots', ${schemaVersion}, 0)
  ON DUPLICATE KEY UPDATE schema_version = ${schemaVersion}`;

/** The columns every event table has, 3.x or 4.0. */
export const EVENT_COLUMNS = [
	'stream_id',
	'version',
	'event',
	'payload',
	'event_id',
	'aggregate_id',
	'occurred_on',
	'correlation_id',
	'causation_id',
] as const;

/** The columns every snapshot table has, 3.x or 4.0. */
export const SNAPSHOT_COLUMNS = [
	'stream_id',
	'version',
	'payload',
	'snapshot_id',
	'aggregate_id',
	'registered_on',
	'aggregate_name',
	'latest',
] as const;

/** What `information_schema.COLUMNS` says about a column. */
export interface ColumnInfo {
	name: string;
	dataType: string;
	columnType: string;
	nullable: boolean;
	collation: string | null;
	maxLength: number | null;
	extra: string;
}

/** An index of a table, with its columns in order. */
export interface IndexInfo {
	name: string;
	unique: boolean;
	columns: string[];
}

/** The columns of a table of the current database, by name; empty when the table doesn't exist. */
export const tableColumns = async (db: Queryable, table: string): Promise<Map<string, ColumnInfo>> => {
	const rows = await db.query<
		{
			COLUMN_NAME: string;
			DATA_TYPE: string;
			COLUMN_TYPE: string;
			IS_NULLABLE: string;
			COLLATION_NAME: string | null;
			CHARACTER_MAXIMUM_LENGTH: bigint | number | null;
			EXTRA: string;
		}[]
	>(
		`SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME, CHARACTER_MAXIMUM_LENGTH, EXTRA
		 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
		[table],
	);
	return new Map(
		rows.map((row) => [
			row.COLUMN_NAME.toLowerCase(),
			{
				name: row.COLUMN_NAME,
				dataType: row.DATA_TYPE.toLowerCase(),
				columnType: row.COLUMN_TYPE.toLowerCase(),
				nullable: row.IS_NULLABLE === 'YES',
				collation: row.COLLATION_NAME,
				maxLength: row.CHARACTER_MAXIMUM_LENGTH === null ? null : Number(row.CHARACTER_MAXIMUM_LENGTH),
				extra: (row.EXTRA ?? '').toLowerCase(),
			},
		]),
	);
};

/** The indexes of a table of the current database. */
export const tableIndexes = async (db: Queryable, table: string): Promise<IndexInfo[]> => {
	const rows = await db.query<{ INDEX_NAME: string; NON_UNIQUE: bigint | number; COLUMN_NAME: string }[]>(
		`SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
		[table],
	);
	const indexes = new Map<string, IndexInfo>();
	for (const row of rows) {
		const index = indexes.get(row.INDEX_NAME) ?? {
			name: row.INDEX_NAME,
			unique: Number(row.NON_UNIQUE) === 0,
			columns: [],
		};
		index.columns.push(row.COLUMN_NAME.toLowerCase());
		indexes.set(row.INDEX_NAME, index);
	}
	return [...indexes.values()];
};

/** The tables of the current database among `tables`. */
export const existingTables = async (db: Queryable, tables: readonly string[]): Promise<Set<string>> => {
	if (tables.length === 0) {
		return new Set();
	}
	const rows = await db.query<{ TABLE_NAME: string }[]>(
		`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME IN (?)`,
		[tables],
	);
	return new Set(rows.map(({ TABLE_NAME }) => TABLE_NAME));
};

/** Whether the catalog exists in the current database. */
export const catalogExists = async (db: Queryable): Promise<boolean> =>
	(await existingTables(db, [CATALOG_TABLE])).has(CATALOG_TABLE);

/** The catalog row of a table, when the catalog exists and has one. */
export interface CatalogRow {
	kind: 'events' | 'snapshots';
	schemaVersion: number;
	lastPosition: bigint;
}

export const catalogRowOf = async (db: Queryable, table: string): Promise<CatalogRow | undefined> => {
	try {
		const [row] = await db.query<{ kind: 'events' | 'snapshots'; schema_version: number; last_position: string }[]>(
			`SELECT kind, schema_version, CAST(last_position AS CHAR) AS last_position FROM ${escapeId(CATALOG_TABLE)} WHERE name = ?`,
			[table],
		);
		return row
			? { kind: row.kind, schemaVersion: Number(row.schema_version), lastPosition: BigInt(row.last_position) }
			: undefined;
	} catch (error) {
		if ((error as { errno?: number })?.errno === 1146) {
			return undefined;
		}
		throw error;
	}
};

/**
 * The schema of an event table, by its columns (ADR 0002 §1):
 * - `v2`: a `NOT NULL` `global_position` and no `event_date`, unless the table is a swapped copy that isn't
 *   registered yet while its 3.x backup exists (a migration that stopped after the swap): that is `v1-partial`;
 * - `v1`: an `event_date` and no `global_position`;
 * - `v1-partial`: anything else.
 */
export type CollectionState = 'absent' | 'v1' | 'v1-partial' | 'v2';

export const classifyEventTable = (
	columns: ReadonlyMap<string, Pick<ColumnInfo, 'nullable'>>,
	{ backup, registered }: { backup: boolean; registered: boolean },
): CollectionState => {
	if (columns.size === 0) {
		return 'absent';
	}
	const globalPosition = columns.get('global_position');
	const eventDate = columns.has('event_date');
	if (globalPosition && !globalPosition.nullable && !eventDate) {
		return backup && !registered ? 'v1-partial' : 'v2';
	}
	if (eventDate && !globalPosition) {
		return 'v1';
	}
	return 'v1-partial';
};

/**
 * The schema of a snapshot table:
 * - `v2`: `registered_on` is a `DATETIME(3)`, the text columns compare in binary, and a unique index on
 *   `(aggregate_name, latest)` is the only index on those columns;
 * - `v1`: `registered_on` is a `TIMESTAMP` (3.x);
 * - `v1-partial`: anything else, such as a migration that stopped halfway.
 */
export const classifySnapshotTable = (
	columns: ReadonlyMap<string, ColumnInfo>,
	indexes: readonly IndexInfo[],
): CollectionState => {
	if (columns.size === 0) {
		return 'absent';
	}
	if (snapshotColumnsAreV2(columns) && latestIndexes(indexes).every(({ unique }) => unique) && hasUniqueLatest(indexes)) {
		return 'v2';
	}
	if (columns.get('registered_on')?.dataType === 'timestamp') {
		return 'v1';
	}
	return 'v1-partial';
};

/** Whether the columns of a snapshot table have their schema v2 types and collation. */
export const snapshotColumnsAreV2 = (columns: ReadonlyMap<string, ColumnInfo>): boolean => {
	const registeredOn = columns.get('registered_on');
	const text = ['stream_id', 'aggregate_id', 'aggregate_name', 'latest'].map((name) => columns.get(name));
	return (
		SNAPSHOT_COLUMNS.every((name) => columns.has(name)) &&
		registeredOn?.columnType === 'datetime(3)' &&
		text.every((column) => column?.collation === 'utf8mb4_bin' && (column.maxLength ?? 0) >= 255) &&
		(columns.get('latest')?.maxLength ?? 0) >= 270
	);
};

/** The indexes whose columns are exactly `(aggregate_name, latest)`. */
export const latestIndexes = (indexes: readonly IndexInfo[]): IndexInfo[] =>
	indexes.filter(({ columns }) => columns.join(',') === 'aggregate_name,latest');

const hasUniqueLatest = (indexes: readonly IndexInfo[]): boolean =>
	latestIndexes(indexes).some(({ unique }) => unique);

/** What the stores and the migration know about an event table. */
export interface EventTableInspection {
	table: string;
	state: CollectionState;
	columns: Map<string, ColumnInfo>;
	registered: boolean;
	catalog: CatalogRow | undefined;
	backup: boolean;
	copy: boolean;
}

export const inspectEventTable = async (db: Queryable, table: string): Promise<EventTableInspection> => {
	const [columns, tables, catalog] = await Promise.all([
		tableColumns(db, table),
		existingTables(db, [backupTableName(table), copyTableName(table)]),
		catalogRowOf(db, table),
	]);
	const registered = catalog?.kind === 'events' && catalog.schemaVersion === 2;
	const backup = tables.has(backupTableName(table));
	return {
		table,
		state: classifyEventTable(columns, { backup, registered }),
		columns,
		registered,
		catalog,
		backup,
		copy: tables.has(copyTableName(table)),
	};
};

/** What the stores and the migration know about a snapshot table. */
export interface SnapshotTableInspection {
	table: string;
	state: CollectionState;
	columns: Map<string, ColumnInfo>;
	indexes: IndexInfo[];
	catalog: CatalogRow | undefined;
}

export const inspectSnapshotTable = async (db: Queryable, table: string): Promise<SnapshotTableInspection> => {
	const [columns, indexes, catalog] = await Promise.all([
		tableColumns(db, table),
		tableIndexes(db, table),
		catalogRowOf(db, table),
	]);
	return { table, state: classifySnapshotTable(columns, indexes), columns, indexes, catalog };
};

/** How to create the schema by hand, for `ddl: 'none'`. */
export const eventSchemaRemedy = (table: string): string =>
	`Create it with ddl: 'auto', or run:\n${catalogDdl()};\n${eventTableDdl(table)};\n${registerEventTableSql(table)};`;

export const snapshotSchemaRemedy = (table: string): string =>
	`Create it with ddl: 'auto', or run:\n${catalogDdl()};\n${snapshotTableDdl(table)};\n${registerSnapshotTableSql(table, 2)};`;
