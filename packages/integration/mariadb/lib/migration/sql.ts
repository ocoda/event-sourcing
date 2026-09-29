import {
	CATALOG_TABLE,
	backupTableName,
	catalogDdl,
	copyTableName,
	escapeId,
	escapeString,
	eventTableDdl,
	LATEST_INDEX,
	registerEventTableSql,
	registerSnapshotTableSql,
} from '../mariadb.schema.js';

/**
 * The statements of the MariaDB migration from 3.x to schema v2 (ADR 0002 §6). Pure functions of their arguments, so
 * that a dry run reports exactly what a migration runs, and `migrations/4.0.sql` is generated from them.
 */

/** The Crockford base32 alphabet of ULIDs. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * An id whose first 10 characters are a ULID time (Crockford base32, any case) and whose 26 characters are letters or
 * digits, as 3.x accepted them. Only the time part is decoded, so the rest may hold I, L, O or U.
 */
export const ULID_TIME_PATTERN = '^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{10}[0-9A-Za-z]{16}$';

/** A canonical ULID: 26 upper-case Crockford base32 characters. */
export const CANONICAL_ULID_PATTERN = '^[0-9A-HJKMNP-TV-Z]{26}$';

/** The largest difference between `occurred_on` and the time of the event id that a time zone explains: 14 hours. */
export const MAX_TIME_ZONE_SHIFT_SECONDS = 14 * 60 * 60;

/** Time zone offsets are whole quarter hours. */
export const TIME_ZONE_STEP_SECONDS = 15 * 60;

/** Options that shape the statements. */
export interface StatementOptions {
	/** Seconds a statement waits for a metadata or row lock. */
	lockWaitSeconds: number;
	/** Whether the session's `sql_mode` has `NO_BACKSLASH_ESCAPES`, which changes how literals are quoted. */
	noBackslashEscapes: boolean;
}

export const DEFAULT_STATEMENT_OPTIONS: StatementOptions = { lockWaitSeconds: 10, noBackslashEscapes: false };

/** The lock wait of the statements for a `lockTimeoutMs`: whole seconds, at least 1. */
export const lockWaitSecondsOf = (lockTimeoutMs = 10_000): number => Math.max(1, Math.ceil(lockTimeoutMs / 1000));

/**
 * The session of the migration: UTC, so that `TIMESTAMP` values convert to UTC wall times; bounded lock waits, so that
 * a table a 3.x instance still uses blocks the migration instead of hanging it; no statement time limit.
 */
export const sessionSql = ({ lockWaitSeconds }: StatementOptions): string =>
	`SET SESSION time_zone = '+00:00', lock_wait_timeout = ${lockWaitSeconds}, innodb_lock_wait_timeout = ${lockWaitSeconds}, max_statement_time = 0`;

/**
 * The named lock of the migration of a table: `ocoda:migrate:` and the SHA-1 of `<database>.<table>`, which keeps the
 * name short (MariaDB 10.11 refuses names over 192 characters).
 */
export const lockNameSql = (table: string, { noBackslashEscapes }: StatementOptions): string =>
	`CONCAT('ocoda:migrate:', SHA1(CONCAT(DATABASE(), '.', ${escapeString(table, noBackslashEscapes)})))`;

export const acquireLockSql = (table: string, options: StatementOptions): string =>
	`SELECT GET_LOCK(${lockNameSql(table, options)}, 0) AS acquired`;

export const releaseLockSql = (table: string, options: StatementOptions): string =>
	`SELECT RELEASE_LOCK(${lockNameSql(table, options)}) AS released`;

/**
 * The millisecond time of a ULID in `column`: its first 10 characters in Crockford base32, as a `BIGINT`. Integer
 * constants instead of `POW(32, k)` keep the sum exact. A JavaScript twin is `ulidMilliseconds`.
 */
export const ulidMillisecondsSql = (column: string): string => {
	const terms = Array.from(
		{ length: 10 },
		(_, index) =>
			`(LOCATE(UPPER(SUBSTRING(${column}, ${index + 1}, 1)), '${CROCKFORD_ALPHABET}') - 1) * ${32n ** BigInt(9 - index)}`,
	);
	return `(${terms.join(' + ')})`;
};

/** The JavaScript twin of `ulidMillisecondsSql`, for the specs. */
export const ulidMilliseconds = (id: string): number =>
	[...id.slice(0, 10).toUpperCase()].reduce((time, character) => time * 32 + CROCKFORD_ALPHABET.indexOf(character), 0);

/**
 * The rows of a 3.x table (alias `o`) with what numbering and the `occurred_on` repair need, computed once per row:
 * - `ord_rank`: the rank in 3.x's order, `(event_date, event_id, stream_id, version)` in the table's collation;
 * - `occurred_ts`: `occurred_on` in seconds since the epoch;
 * - `ulid_valid`, `ulid_ms`: whether the event id has a ULID time, and that time in milliseconds.
 */
const rankedRowsSql = (from: string, where = ''): string =>
	`SELECT o.stream_id, o.version, o.event, o.payload, o.event_id, o.aggregate_id, o.occurred_on, o.correlation_id, o.causation_id,
      CAST(UNIX_TIMESTAMP(o.occurred_on) AS SIGNED) AS occurred_ts,
      o.event_id REGEXP '${ULID_TIME_PATTERN}' AS ulid_valid,
      ${ulidMillisecondsSql('o.event_id')} AS ulid_ms,
      ROW_NUMBER() OVER (ORDER BY o.event_date, o.event_id, o.stream_id, o.version) AS ord_rank
    FROM ${from}${where}`;

/**
 * The rows with their numbering key (ADR 0001 D33): the running maximum of `ord_rank` over the row's stream, by
 * version. Numbering by `(ord_key, version)` follows 3.x's order, except that a stream's events keep their version
 * order.
 */
const keyedRowsSql = (ranked: string): string =>
	`SELECT r.*, MAX(r.ord_rank) OVER (PARTITION BY r.stream_id ORDER BY r.version ROWS UNBOUNDED PRECEDING) AS ord_key
  FROM (
    ${ranked}
  ) r`;

/** Whether the `occurred_on` of a ranked row differs from its ULID time by a time zone offset only. */
const repairableSql = (): string => {
	const difference = '(k.occurred_ts - k.ulid_ms DIV 1000)';
	return `k.ulid_valid = 1 AND ABS(${difference}) <= ${MAX_TIME_ZONE_SHIFT_SECONDS} AND MOD(${difference}, ${TIME_ZONE_STEP_SECONDS}) = 0`;
};

/**
 * The `occurred_on` of a migrated row: the time of its event id, to the millisecond, when the stored value differs from
 * it by a whole number of quarter hours within ±14 hours (3.x truncated to the second, and a Node.js process in another
 * time zone than the server's shifted it); otherwise the stored value, as UTC wall time.
 */
export const occurredOnSql = (repair: boolean): string =>
	repair
		? `CASE WHEN ${repairableSql()} THEN FROM_UNIXTIME(k.ulid_ms DIV 1000) + INTERVAL (k.ulid_ms MOD 1000) * 1000 MICROSECOND ELSE k.occurred_on END`
		: 'k.occurred_on';

const MIGRATED_COLUMNS =
	'stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id, global_position';

/** Creates the copy of a table in the v2 schema, which the migration fills and swaps in. */
export const dropCopySql = (table: string): string => `DROP TABLE IF EXISTS ${escapeId(copyTableName(table))}`;

export const createCopySql = (table: string): string => eventTableDdl(copyTableName(table), { ifNotExists: false });

/** A bulk load into the empty copy: no unique or foreign key checks (MDEV-24621). The copy's rows are unique anyway. */
export const bulkLoadOnSql = (): string => 'SET SESSION unique_checks = 0, foreign_key_checks = 0';
export const bulkLoadOffSql = (): string => 'SET SESSION unique_checks = 1, foreign_key_checks = 1';

/** Copies every row of the 3.x table into the copy, numbered and with the repaired `occurred_on`. */
export const copySql = (table: string, { repairOccurredOn }: { repairOccurredOn: boolean }): string =>
	`INSERT INTO ${escapeId(copyTableName(table))} (${MIGRATED_COLUMNS})
SELECT k.stream_id, k.version, k.event, k.payload, k.event_id, k.aggregate_id, ${occurredOnSql(repairOccurredOn)},
  k.correlation_id, k.causation_id, ROW_NUMBER() OVER (ORDER BY k.ord_key, k.version) AS global_position
FROM (
  ${keyedRowsSql(rankedRowsSql(`${escapeId(table)} o`))}
) k`;

/** Swaps the copy in, atomically: from here on, a 3.x insert fails (1136: the column count doesn't match). */
export const swapSql = (table: string): string =>
	`RENAME TABLE ${escapeId(table)} TO ${escapeId(backupTableName(table))}, ${escapeId(copyTableName(table))} TO ${escapeId(table)}`;

/**
 * Copies the rows that 3.x wrote to the old table after the copy read it and before the swap (normally none), numbered
 * after the last position with the same rule. The join converts the old stream ids, whose table may be latin1 or
 * utf8mb3, before it compares them in binary.
 */
export const catchUpSql = (table: string, { repairOccurredOn }: { repairOccurredOn: boolean }): string =>
	`INSERT INTO ${escapeId(table)} (${MIGRATED_COLUMNS})
SELECT k.stream_id, k.version, k.event, k.payload, k.event_id, k.aggregate_id, ${occurredOnSql(repairOccurredOn)},
  k.correlation_id, k.causation_id, b.base + ROW_NUMBER() OVER (ORDER BY k.ord_key, k.version) AS global_position
FROM (
  ${keyedRowsSql(
		rankedRowsSql(
			`${escapeId(backupTableName(table))} o LEFT JOIN ${escapeId(table)} n
      ON n.stream_id = CONVERT(o.stream_id USING utf8mb4) COLLATE utf8mb4_bin AND n.version = o.version`,
			'\n    WHERE n.stream_id IS NULL',
		),
	)}
) k
CROSS JOIN (SELECT COALESCE(MAX(global_position), 0) AS base FROM ${escapeId(table)}) b`;

export const dropBackupSql = (table: string): string => `DROP TABLE IF EXISTS ${escapeId(backupTableName(table))}`;

export const createCatalogSql = (): string => catalogDdl();

export const registerEventsSql = (table: string, { noBackslashEscapes }: StatementOptions): string =>
	registerEventTableSql(table, noBackslashEscapes);

// Snapshots

/**
 * Converts a 3.x snapshot table in place: binary collation, the v2 column sizes, `DATETIME(3)` for `registered_on` (as
 * UTC wall time: the session is UTC), without the `ON UPDATE` attribute of servers created before MariaDB 10.10, and
 * without the non-unique indexes on `(aggregate_name, latest)`. The unique index comes after the flags are repaired.
 */
export const convertSnapshotsSql = (table: string, dropIndexes: readonly string[]): string =>
	[
		`ALTER TABLE ${escapeId(table)} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
		'  MODIFY stream_id VARCHAR(255) NOT NULL',
		'  MODIFY aggregate_id VARCHAR(255) NOT NULL',
		'  MODIFY registered_on DATETIME(3) NOT NULL',
		'  MODIFY aggregate_name VARCHAR(255) NOT NULL',
		'  MODIFY latest VARCHAR(270) NULL',
		...dropIndexes.map((index) => `  DROP INDEX ${escapeId(index)}`),
		'  ALGORITHM=COPY, LOCK=SHARED',
	].join(',\n');

/** The highest version of every stream, in binary comparison (the table is converted by then). */
const lastVersionsSql = (table: string): string =>
	`(SELECT stream_id, MAX(version) AS version FROM ${escapeId(table)} GROUP BY stream_id)`;

/**
 * Unflags every snapshot that isn't the highest version of its stream. Assigning `registered_on` to itself keeps the
 * legacy `ON UPDATE` attribute from firing, should the table still have it.
 */
export const unflagSupersededSql = (table: string): string =>
	`UPDATE ${escapeId(table)} s JOIN ${lastVersionsSql(table)} m ON s.stream_id = m.stream_id
SET s.latest = NULL, s.registered_on = s.registered_on
WHERE s.latest IS NOT NULL AND s.version < m.version`;

/** Flags the highest version of every stream that isn't flagged (right). */
export const flagLatestSql = (table: string): string =>
	`UPDATE ${escapeId(table)} s JOIN ${lastVersionsSql(table)} m ON s.stream_id = m.stream_id AND s.version = m.version
SET s.latest = CONCAT('latest#', s.stream_id), s.registered_on = s.registered_on
WHERE s.latest IS NULL OR s.latest <> CONCAT('latest#', s.stream_id)`;

export const addUniqueLatestSql = (table: string): string =>
	`ALTER TABLE ${escapeId(table)} ADD UNIQUE KEY ${LATEST_INDEX} (aggregate_name, latest), ALGORITHM=INPLACE, LOCK=SHARED`;

export const registerSnapshotsSql = (table: string, { noBackslashEscapes }: StatementOptions): string =>
	registerSnapshotTableSql(table, 2, noBackslashEscapes);

// Dry-run analysis

/** Streams (compared in binary, as schema v2 compares them) whose versions don't run from 1 without gaps. */
const gappedGroupsSql = (table: string): string =>
	`SELECT MIN(CONVERT(stream_id USING utf8mb4)) AS stream_id, COUNT(*) AS events, MIN(version) AS min_version, MAX(version) AS max_version
  FROM ${escapeId(table)} GROUP BY CAST(stream_id AS BINARY) HAVING MIN(version) <> 1 OR MAX(version) <> COUNT(*)`;

export const gappedStreamsSampleSql = (table: string, limit = 1000): string =>
	`${gappedGroupsSql(table)} ORDER BY MIN(CAST(stream_id AS BINARY)) LIMIT ${limit}`;

export const gappedStreamsTotalSql = (table: string): string =>
	`SELECT COUNT(*) AS total FROM (${gappedGroupsSql(table)}) g`;

/** Streams whose id matches others that differ in case only: schema v2 splits them. */
export const caseVariantStreamsSql = (table: string): string =>
	`SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${escapeId(table)} GROUP BY stream_id HAVING COUNT(DISTINCT CAST(stream_id AS BINARY)) > 1) g`;

export const duplicateEventIdsSql = (table: string): string =>
	`SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${escapeId(table)} GROUP BY CAST(event_id AS BINARY) HAVING COUNT(*) > 1) d`;

export const nonCrockfordEventIdsSql = (table: string): string =>
	`SELECT COUNT(*) AS total FROM ${escapeId(table)} WHERE CAST(event_id AS BINARY) NOT REGEXP '${CANONICAL_ULID_PATTERN}'`;

/** How the `occurred_on` repair treats the rows: already exact, gains milliseconds, shifted back, or kept. */
export const occurredOnRepairSql = (table: string): string =>
	`SELECT
  COALESCE(SUM(fix AND difference = 0 AND millis = 0), 0) AS exact,
  COALESCE(SUM(fix AND difference = 0 AND millis <> 0), 0) AS precision_only,
  COALESCE(SUM(fix AND difference <> 0), 0) AS tz_shifted,
  COALESCE(SUM(NOT fix), 0) AS kept
FROM (
  SELECT ${repairableSql()} AS fix, k.occurred_ts - k.ulid_ms DIV 1000 AS difference, k.ulid_ms MOD 1000 AS millis
  FROM (
    SELECT CAST(UNIX_TIMESTAMP(o.occurred_on) AS SIGNED) AS occurred_ts,
      o.event_id REGEXP '${ULID_TIME_PATTERN}' AS ulid_valid,
      ${ulidMillisecondsSql('o.event_id')} AS ulid_ms
    FROM ${escapeId(table)} o
  ) k
) x`;

/** Flags per snapshot stream (in binary comparison): more than one, none, or not on the highest version. */
export const snapshotFlagsSql = (table: string): string =>
	`SELECT
  COALESCE(SUM(flags > 1), 0) AS duplicate_latest,
  COALESCE(SUM(flags = 0), 0) AS missing_latest,
  COALESCE(SUM(flags > 0 AND last_flagged < last_version), 0) AS misplaced_latest
FROM (
  SELECT COUNT(latest) AS flags, MAX(version) AS last_version, MAX(CASE WHEN latest IS NOT NULL THEN version END) AS last_flagged
  FROM ${escapeId(table)} GROUP BY CAST(stream_id AS BINARY)
) f`;

/** The catalog's name, quoted, for the statements that name it. */
export const catalogId = (): string => escapeId(CATALOG_TABLE);
