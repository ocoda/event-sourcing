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
	/** Whether the server is a Galera node (`@@wsrep_on`): a copy then replicates in fragments. */
	galera: boolean;
	/** On Galera, the size of those fragments (`galeraFragmentBytesOf`); `GALERA_FRAGMENT_BYTES` when omitted. */
	galeraFragmentBytes?: number;
}

export const DEFAULT_STATEMENT_OPTIONS: StatementOptions = {
	lockWaitSeconds: 10,
	noBackslashEscapes: false,
	galera: false,
};

/**
 * The largest fragment size of Galera's streaming replication for the migration's statements: a copy is one write
 * set, and `wsrep_max_ws_size` (2 GiB at most) refuses a bigger one.
 */
export const GALERA_FRAGMENT_BYTES = 64 * 1024 * 1024;

/** The smallest fragment size the migration picks: below it, the replication overhead outweighs the fragments. */
export const GALERA_MIN_FRAGMENT_BYTES = 1024 * 1024;

/**
 * The fragment size for a node's `wsrep_max_ws_size`: 64 MiB, or half the largest write set when that is smaller, so
 * that no fragment exceeds it and nobody has to raise it or pick a fragment size by hand.
 */
export const galeraFragmentBytesOf = (maxWriteSetBytes: number | undefined): number =>
	maxWriteSetBytes === undefined || !Number.isFinite(maxWriteSetBytes) || maxWriteSetBytes <= 0
		? GALERA_FRAGMENT_BYTES
		: Math.max(GALERA_MIN_FRAGMENT_BYTES, Math.min(GALERA_FRAGMENT_BYTES, Math.floor(maxWriteSetBytes / 2)));

/** The lock wait of the statements for a `lockTimeoutMs`: whole seconds, at least 1. */
export const lockWaitSecondsOf = (lockTimeoutMs = 10_000): number => Math.max(1, Math.ceil(lockTimeoutMs / 1000));

/**
 * The session of the migration:
 * - UTC, so that `TIMESTAMP` values convert to UTC wall times;
 * - bounded lock waits, so that a table a 3.x instance still uses blocks the migration instead of hanging it;
 * - no statement time limit;
 * - `REPEATABLE READ`, whatever the server's default: the copy then locks the rows it reads, a fence against 3.x
 *   writes, and a binary log in `STATEMENT` format accepts it;
 * - on Galera, streaming replication in fragments, so that the copy doesn't exceed the largest write set.
 */
export const sessionSql = ({ lockWaitSeconds, galera, galeraFragmentBytes }: StatementOptions): string =>
	[
		`SET SESSION time_zone = '+00:00', lock_wait_timeout = ${lockWaitSeconds}, innodb_lock_wait_timeout = ${lockWaitSeconds}`,
		"max_statement_time = 0, tx_isolation = 'REPEATABLE-READ'",
		...(galera
			? [`wsrep_trx_fragment_unit = 'bytes', wsrep_trx_fragment_size = ${galeraFragmentBytes ?? GALERA_FRAGMENT_BYTES}`]
			: []),
	].join(', ');

/**
 * The named lock of the migration of a table: `ocoda:migrate:` and the SHA-1 of `<database>.<table>`, which keeps the
 * name short (MariaDB 10.11 refuses names over 192 characters).
 */
export const lockNameSql = (
	table: string,
	{ noBackslashEscapes }: Pick<StatementOptions, 'noBackslashEscapes'>,
): string => `CONCAT('ocoda:migrate:', SHA1(CONCAT(DATABASE(), '.', ${escapeString(table, noBackslashEscapes)})))`;

/**
 * Takes the named lock, or fails with error 1242 (`Subquery returns more than 1 row`) when another session holds it, so
 * that the `mariadb` command-line client stops there too when it runs the statements of a file.
 */
export const acquireLockSql = (table: string, options: StatementOptions): string =>
	`SELECT IF(GET_LOCK(${lockNameSql(table, options)}, 0) = 1, 1, (SELECT 1 UNION SELECT 2)) AS acquired`;

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
 *
 * `extra` passes more columns of `o` through, such as the catch-up's `first_stream_id` and `first_aggregate_id`.
 */
const rankedRowsSql = (from: string, extra = ''): string =>
	`SELECT o.stream_id, o.version, o.event, o.payload, o.event_id, o.aggregate_id, o.occurred_on, o.correlation_id, o.causation_id,${extra}
      CAST(UNIX_TIMESTAMP(o.occurred_on) AS SIGNED) AS occurred_ts,
      o.event_id REGEXP '${ULID_TIME_PATTERN}' AS ulid_valid,
      ${ulidMillisecondsSql('o.event_id')} AS ulid_ms,
      ROW_NUMBER() OVER (ORDER BY o.event_date, o.event_id, o.stream_id, o.version) AS ord_rank
    FROM ${from}`;

/** A row's 3.x stream, by version: the partition compares stream ids in the 3.x table's collation. */
const STREAM_WINDOW = 'PARTITION BY r.stream_id ORDER BY r.version ROWS UNBOUNDED PRECEDING';

/**
 * The rows with their numbering key (ADR 0001 D33): the running maximum of `ord_rank` over the row's stream, by
 * version. Numbering by `(ord_key, version)` follows 3.x's order, except that a stream's events keep their version
 * order.
 *
 * The stream is the 3.x stream: the partition compares stream ids in the 3.x table's collation, which usually ignores
 * case, so ids that differ in case only are one stream. With `firstValues`, each row also gets the stream id and the
 * aggregate id of its stream's lowest version (`first_stream_id`, `first_aggregate_id`), which the copy gives the
 * whole stream (ADR 0002, amendment of 2026-09-30). The window functions share one sort.
 */
const keyedRowsSql = (ranked: string, { firstValues }: { firstValues: boolean }): string =>
	`SELECT r.*, MAX(r.ord_rank) OVER (${STREAM_WINDOW}) AS ord_key${
		firstValues
			? `,
    FIRST_VALUE(r.stream_id) OVER (${STREAM_WINDOW}) AS first_stream_id,
    FIRST_VALUE(r.aggregate_id) OVER (${STREAM_WINDOW}) AS first_aggregate_id`
			: ''
	}
  FROM (
    ${ranked}
  ) r`;

/**
 * The stream id and the aggregate id of a keyed row (alias `k`) in schema v2: every row of a 3.x stream takes the
 * stream id of the stream's lowest version, and a row whose stream id changes also takes that version's aggregate id
 * when the two differ in case only (they compare equal in the 3.x collation).
 */
const CANONICAL_STREAM_ID = 'k.first_stream_id';
const CANONICAL_AGGREGATE_ID =
	'CASE WHEN CAST(k.stream_id AS BINARY) <> CAST(k.first_stream_id AS BINARY) AND k.aggregate_id = k.first_aggregate_id THEN k.first_aggregate_id ELSE k.aggregate_id END';

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

/**
 * Copies every row of the 3.x table into the copy: numbered, with the repaired `occurred_on`, and with one stream id
 * per 3.x stream.
 */
export const copySql = (table: string, { repairOccurredOn }: { repairOccurredOn: boolean }): string =>
	`INSERT INTO ${escapeId(copyTableName(table))} (${MIGRATED_COLUMNS})
SELECT ${CANONICAL_STREAM_ID}, k.version, k.event, k.payload, k.event_id, ${CANONICAL_AGGREGATE_ID}, ${occurredOnSql(repairOccurredOn)},
  k.correlation_id, k.causation_id, ROW_NUMBER() OVER (ORDER BY k.ord_key, k.version) AS global_position
FROM (
  ${keyedRowsSql(rankedRowsSql(`${escapeId(table)} o`), { firstValues: true })}
) k`;

/** Swaps the copy in, atomically: from here on, a 3.x insert fails (1136: the column count doesn't match). */
export const swapSql = (table: string): string =>
	`RENAME TABLE ${escapeId(table)} TO ${escapeId(backupTableName(table))}, ${escapeId(copyTableName(table))} TO ${escapeId(table)}`;

/**
 * The stream id or aggregate id of the lowest version of a backup row's 3.x stream (alias `o`): one lookup in the
 * backup's primary key, which compares stream ids in the 3.x collation.
 */
const firstOfStreamSql = (backup: string, column: 'stream_id' | 'aggregate_id'): string =>
	`(SELECT f.${column} FROM ${backup} f WHERE f.stream_id = o.stream_id ORDER BY f.version LIMIT 1)`;

/**
 * Copies the rows that 3.x wrote to the old table after the copy read it and before the swap (normally none): numbered
 * after the last position with the same rule, and with the stream id the copy gives their stream.
 *
 * A backup row is in the new table already when the new table has its version under its own stream id or under the id
 * of its stream's lowest version (the copy replaced its id). Only the rows that the first lookup misses look up their
 * stream's lowest version. The joins convert the old stream ids, whose table may be latin1 or utf8mb3, before they
 * compare them in binary.
 */
export const catchUpSql = (table: string, { repairOccurredOn }: { repairOccurredOn: boolean }): string => {
	const backup = escapeId(backupTableName(table));
	const missing = `(
      SELECT m.* FROM (
        SELECT o.*, ${firstOfStreamSql(backup, 'stream_id')} AS first_stream_id,
          ${firstOfStreamSql(backup, 'aggregate_id')} AS first_aggregate_id
        FROM ${backup} o LEFT JOIN ${escapeId(table)} n
          ON n.stream_id = CONVERT(o.stream_id USING utf8mb4) COLLATE utf8mb4_bin AND n.version = o.version
        WHERE n.stream_id IS NULL
      ) m LEFT JOIN ${escapeId(table)} c
        ON c.stream_id = CONVERT(m.first_stream_id USING utf8mb4) COLLATE utf8mb4_bin AND c.version = m.version
      WHERE c.stream_id IS NULL
    ) o`;
	return `INSERT INTO ${escapeId(table)} (${MIGRATED_COLUMNS})
SELECT ${CANONICAL_STREAM_ID}, k.version, k.event, k.payload, k.event_id, ${CANONICAL_AGGREGATE_ID}, ${occurredOnSql(repairOccurredOn)},
  k.correlation_id, k.causation_id, b.base + ROW_NUMBER() OVER (ORDER BY k.ord_key, k.version) AS global_position
FROM (
  ${keyedRowsSql(rankedRowsSql(missing, ' o.first_stream_id, o.first_aggregate_id,'), { firstValues: false })}
) k
CROSS JOIN (SELECT COALESCE(MAX(global_position), 0) AS base FROM ${escapeId(table)}) b`;
};

export const dropBackupSql = (table: string): string => `DROP TABLE IF EXISTS ${escapeId(backupTableName(table))}`;

export const createCatalogSql = (): string => catalogDdl();

export const registerEventsSql = (table: string, { noBackslashEscapes }: StatementOptions): string =>
	registerEventTableSql(table, noBackslashEscapes);

// Snapshots

/**
 * One row per 3.x snapshot stream (the table's collation groups the ids that differ in case only): `stream_key`, the
 * stream as the table compares it, and the `stream_id`, `aggregate_id` and `aggregate_name` that its snapshots take.
 *
 * - With `events`, the pool's 3.x event rows (its 3.x event table, or that table's `__es_v1` backup, whose stream ids
 *   compare like the snapshots'), a stream that has events takes the stream id and the aggregate id of its lowest event
 *   version, which the event migration gives the stream too, and the aggregate name at the start of that stream id.
 *   Two lookups per stream in the events' primary key.
 * - Otherwise, and for a stream without events, it takes the ids and the name of its lowest snapshot version.
 */
export const canonicalSnapshotStreamsSql = (table: string, events?: string): string => {
	const first = `SELECT g.stream_id AS stream_key, f.stream_id AS first_stream_id, f.aggregate_id AS first_aggregate_id,
      f.aggregate_name AS first_aggregate_name${
				events
					? `,
      (SELECT e.stream_id FROM ${escapeId(events)} e WHERE e.stream_id = g.stream_id ORDER BY e.version LIMIT 1) AS event_stream_id,
      (SELECT e.aggregate_id FROM ${escapeId(events)} e WHERE e.stream_id = g.stream_id ORDER BY e.version LIMIT 1) AS event_aggregate_id`
					: ''
			}
    FROM (SELECT stream_id, MIN(version) AS version FROM ${escapeId(table)} GROUP BY stream_id) g
    JOIN ${escapeId(table)} f ON f.stream_id = g.stream_id AND f.version = g.version`;
	if (!events) {
		return `SELECT a.stream_key, a.first_stream_id AS stream_id, a.first_aggregate_id AS aggregate_id, a.first_aggregate_name AS aggregate_name
  FROM (
    ${first}
  ) a`;
	}
	const eventName = 'LEFT(a.event_stream_id, CHAR_LENGTH(a.first_aggregate_name))';
	return `SELECT a.stream_key, COALESCE(a.event_stream_id, a.first_stream_id) AS stream_id,
    COALESCE(a.event_aggregate_id, a.first_aggregate_id) AS aggregate_id,
    CASE WHEN ${eventName} = a.first_aggregate_name THEN ${eventName} ELSE a.first_aggregate_name END AS aggregate_name
  FROM (
    ${first}
  ) a`;
};

/**
 * Gives every snapshot of a 3.x stream one stream id (`canonicalSnapshotStreamsSql`), before the conversion makes the
 * table compare stream ids in binary. A snapshot whose stream id changes also takes the stream's aggregate id and
 * aggregate name, each when the two differ in case only. The primary key compares the old and the new id as equal, so
 * no two snapshots can collide. Assigning `registered_on` to itself keeps the legacy `ON UPDATE` attribute from firing;
 * the flags are repaired after the conversion.
 */
export const canonicalizeSnapshotsSql = (table: string, events?: string): string =>
	`UPDATE ${escapeId(table)} s JOIN (
  ${canonicalSnapshotStreamsSql(table, events)}
) c ON s.stream_id = c.stream_key
SET s.aggregate_id = CASE WHEN s.aggregate_id = c.aggregate_id THEN c.aggregate_id ELSE s.aggregate_id END,
  s.aggregate_name = CASE WHEN s.aggregate_name = c.aggregate_name THEN c.aggregate_name ELSE s.aggregate_name END,
  s.stream_id = c.stream_id, s.registered_on = s.registered_on
WHERE CAST(s.stream_id AS BINARY) <> CAST(c.stream_id AS BINARY)`;

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

/**
 * 3.x streams whose versions don't run from 1 without gaps. The table's collation groups the ids that differ in case
 * only, like the copy, which gives them one stream id.
 */
const gappedGroupsSql = (table: string): string =>
	`SELECT stream_id, COUNT(*) AS events, MIN(version) AS min_version, MAX(version) AS max_version
  FROM ${escapeId(table)} GROUP BY stream_id HAVING MIN(version) <> 1 OR MAX(version) <> COUNT(*)`;

/** The gapped streams, by the stream id that the migration gives them (their lowest version's), in binary order. */
export const gappedStreamsSampleSql = (table: string, limit = 1000): string =>
	`SELECT CONVERT(f.stream_id USING utf8mb4) AS stream_id, g.events, g.min_version, g.max_version
FROM (${gappedGroupsSql(table)}) g JOIN ${escapeId(table)} f ON f.stream_id = g.stream_id AND f.version = g.min_version
ORDER BY CAST(CONVERT(f.stream_id USING utf8mb4) AS BINARY) LIMIT ${limit}`;

export const gappedStreamsTotalSql = (table: string): string =>
	`SELECT COUNT(*) AS total FROM (${gappedGroupsSql(table)}) g`;

/** 3.x streams whose rows have ids that differ in case only: the migration gives each one stream id. */
export const caseVariantStreamsSql = (table: string): string =>
	`SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${escapeId(table)} GROUP BY stream_id HAVING COUNT(DISTINCT CAST(stream_id AS BINARY)) > 1) g`;

/**
 * The stream ids that the migration replaces, one row per stream id: the id it takes (`stream_id`), the replaced id
 * (`variant`) and its rows (`changed`). `canonical` has a row per 3.x stream, `stream_key` and the `stream_id` it takes.
 */
const replacedStreamIdsSql = (table: string, canonical: string): string =>
	`SELECT MIN(CONVERT(c.stream_id USING utf8mb4)) AS stream_id, MIN(CONVERT(o.stream_id USING utf8mb4)) AS variant, COUNT(*) AS changed
FROM ${escapeId(table)} o JOIN (
  ${canonical}
) c ON o.stream_id = c.stream_key
WHERE CAST(o.stream_id AS BINARY) <> CAST(c.stream_id AS BINARY)
GROUP BY CAST(c.stream_id AS BINARY), CAST(o.stream_id AS BINARY)`;

/** The event stream ids that the copy replaces with the id of their stream's lowest version. */
export const canonicalizedEventStreamsSql = (table: string): string =>
	replacedStreamIdsSql(
		table,
		`SELECT g.stream_id AS stream_key, f.stream_id
  FROM (
    SELECT stream_id, MIN(version) AS version FROM ${escapeId(table)}
    GROUP BY stream_id HAVING COUNT(DISTINCT CAST(stream_id AS BINARY)) > 1
  ) g JOIN ${escapeId(table)} f ON f.stream_id = g.stream_id AND f.version = g.version`,
	);

/** The snapshot stream ids that the canonicalization replaces (`canonicalizeSnapshotsSql`). */
export const canonicalizedSnapshotStreamsSql = (table: string, events?: string): string =>
	replacedStreamIdsSql(table, canonicalSnapshotStreamsSql(table, events));

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

/**
 * Flags per snapshot stream: more than one, none, or not on the highest version. The table's collation groups the ids
 * that differ in case only, which the migration gives one stream id (a converted table compares them in binary).
 */
export const snapshotFlagsSql = (table: string): string =>
	`SELECT
  COALESCE(SUM(flags > 1), 0) AS duplicate_latest,
  COALESCE(SUM(flags = 0), 0) AS missing_latest,
  COALESCE(SUM(flags > 0 AND last_flagged < last_version), 0) AS misplaced_latest
FROM (
  SELECT COUNT(latest) AS flags, MAX(version) AS last_version, MAX(CASE WHEN latest IS NOT NULL THEN version END) AS last_flagged
  FROM ${escapeId(table)} GROUP BY stream_id
) f`;

/** The catalog's name, quoted, for the statements that name it. */
export const catalogId = (): string => escapeId(CATALOG_TABLE);
