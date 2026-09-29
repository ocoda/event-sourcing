import type { Readable } from 'node:stream';
import type { Pool, PoolConfig } from 'mariadb';
import type { Queryable } from './mariadb.schema.js';

/** MariaDB error numbers the stores classify. */
export const MariaDBErrorNumber = {
	/** `ER_CHECKREAD`: a record changed after the read view of a transaction (`innodb_snapshot_isolation=ON`). */
	CheckRead: 1020,
	/** `ER_DISK_FULL`. */
	DiskFull: 1021,
	/** `ER_DBACCESS_DENIED_ERROR`: a missing privilege on a database. */
	DatabaseAccessDenied: 1044,
	/** `ER_BAD_FIELD_ERROR`: an unknown column, such as `global_position` on a 3.x table. */
	BadField: 1054,
	/** `ER_DUP_ENTRY`: a duplicate on a primary key or unique index. */
	DuplicateEntry: 1062,
	/** `ER_RECORD_FILE_FULL`: a table, such as a temporary table in `tmpdir`, is full. */
	RecordFileFull: 1114,
	/** `ER_TABLEACCESS_DENIED_ERROR`: a missing privilege on a table. */
	TableAccessDenied: 1142,
	/** `ER_NO_SUCH_TABLE`. */
	NoSuchTable: 1146,
	/** `ER_UNKNOWN_SYSTEM_VARIABLE`, such as `@@wsrep_on` on a server without Galera. */
	UnknownSystemVariable: 1193,
	/** `ER_LOCK_WAIT_TIMEOUT`. */
	LockWaitTimeout: 1205,
	/** `ER_LOCK_TABLE_FULL`: the row locks of a transaction outgrew the buffer pool. */
	LockTableFull: 1206,
	/** `ER_LOCK_DEADLOCK`: also a Galera certification failure at `COMMIT`. */
	Deadlock: 1213,
	/** `ER_SPECIFIC_ACCESS_DENIED_ERROR`: a missing privilege, such as `SUPER`. */
	SpecificAccessDenied: 1227,
	/** `ER_SUBQUERY_NO_1_ROW`: what the migration's lock statement raises when another migration holds the lock. */
	SubqueryReturnsMoreThanOneRow: 1242,
} as const;

/** The error number of an error of the `mariadb` connector, if it has one. */
export const errorNumberOf = (error: unknown): number | undefined => {
	const errno = (error as { errno?: unknown } | null | undefined)?.errno;
	return typeof errno === 'number' ? errno : undefined;
};

/**
 * Whether an error thrown by the `mariadb` connector is a duplicate-key violation.
 */
export const isDuplicateEntryError = (error: unknown): boolean => {
	const { errno, code } = (error ?? {}) as { errno?: unknown; code?: unknown };
	return errno === MariaDBErrorNumber.DuplicateEntry || code === 'ER_DUP_ENTRY';
};

/**
 * The name of the key a duplicate-key error names (`PRIMARY`, `ux_global_position`, ...), from the end of its message:
 * MariaDB writes `Duplicate entry '<value>' for key 'PRIMARY'`, MySQL `for key 'table.PRIMARY'`. The value is not
 * escaped, so a stream id can hold `for key '...'` itself: only the last one names the key.
 */
export const duplicateKeyOf = (error: unknown): string | undefined => {
	const message = (error as { sqlMessage?: unknown; message?: unknown } | null | undefined) ?? {};
	// The connector's message adds the statement after a line break
	const text =
		typeof message.sqlMessage === 'string' ? message.sqlMessage : String(message.message ?? '').split('\n', 1)[0];
	return /for key '(?:[^']*\.)?([^.']+)'$/.exec(text)?.[1];
};

/**
 * Whether the server is a Galera node (`@@wsrep_on`), whose row locks don't order the commits of other nodes. A server
 * without the variable (1193) isn't one.
 * @throws what the query throws otherwise, such as a connection error
 */
export const isGaleraNode = async (db: Queryable): Promise<boolean> => {
	let wsrep: unknown;
	try {
		[{ wsrep }] = await db.query<{ wsrep: unknown }[]>('SELECT @@wsrep_on AS wsrep');
	} catch (error) {
		if (errorNumberOf(error) === MariaDBErrorNumber.UnknownSystemVariable) {
			return false;
		}
		throw error;
	}
	return wsrep === 1 || wsrep === 1n || wsrep === true || String(wsrep).toUpperCase() === 'ON';
};

/**
 * The pool options of a store: its `initSql` runs first, then `READ COMMITTED` for the session, so that a read never
 * sees an append that isn't committed yet (`READ UNCOMMITTED`) whatever the server's default isolation is. Appends and
 * snapshot writes set their isolation per transaction anyway.
 */
export const withReadCommitted = (config: PoolConfig): PoolConfig => ({
	...config,
	initSql: [...[config.initSql ?? []].flat(), 'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED'],
});

/**
 * Whether the connector marked the error as fatal for its connection (a lost or broken connection), so that the
 * connection must be destroyed rather than handed back to the pool.
 */
export const isFatalConnectionError = (error: unknown): boolean =>
	Boolean((error as { fatal?: unknown } | null | undefined)?.fatal);

/**
 * A `DATETIME(3)` value for a date: its UTC wall time to the millisecond. Schema v2 stores UTC wall times, written and
 * read as strings, so neither the connector's `timezone` nor the session's `time_zone` changes them.
 * @throws RangeError for an invalid date
 */
export const toDateTime = (date: Date): string => date.toISOString().slice(0, 23).replace('T', ' ');

/**
 * The date of a `DATETIME(3)` value read as text (`CAST(column AS CHAR)`): a UTC wall time.
 */
export const fromDateTime = (value: string | Date): Date =>
	value instanceof Date ? value : new Date(`${value.replace(' ', 'T')}Z`);

/**
 * A JSON column's value. The connector parses JSON columns (`autoJsonMap`, the default); with `autoJsonMap: false` it
 * returns the text, which is parsed here.
 */
export const fromJson = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

/**
 * Streams the rows of a query over a dedicated pool connection.
 *
 * - Errors raised by the query (e.g. a missing table or a dropped connection) are propagated to the consumer,
 *   they are never swallowed.
 * - When the consumer stops early (`break`, `return` or a thrown error), the remaining rows are discarded and the
 *   connection is released back to the pool.
 */
export async function* streamRows<Row>(pool: Pool, sql: string, params?: unknown[]): AsyncGenerator<Row> {
	const connection = await pool.getConnection();
	let stream: Readable | undefined;

	try {
		stream = connection.queryStream(sql, params);
		// The connector emits errors on the stream itself, also after we stopped listening (e.g. on an early exit).
		// An unhandled 'error' event would crash the process, the ones that matter are surfaced by the iteration below.
		stream.on('error', () => undefined);

		yield* stream as unknown as AsyncIterable<Row>;
	} finally {
		if (stream) {
			// `close()` (connector specific) discards the rows that are still in flight and resumes the socket. Destroying
			// a partially consumed stream alone leaves the socket paused, which makes `release()` wait forever.
			(stream as unknown as { close?: () => void }).close?.();
			stream.destroy();
		}
		await connection.release();
	}
}

/**
 * Hands out the items of an async iterable in batches of `size`; the last one may be smaller.
 */
export async function* inBatches<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
	let batch: T[] = [];
	for await (const item of items) {
		batch.push(item);
		if (batch.length === size) {
			yield batch;
			batch = [];
		}
	}
	if (batch.length > 0) {
		yield batch;
	}
}
