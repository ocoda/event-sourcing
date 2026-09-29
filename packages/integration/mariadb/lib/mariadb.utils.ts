import type { Readable } from 'node:stream';
import type { Pool } from 'mariadb';

/** MariaDB error numbers the stores classify. */
export const MariaDBErrorNumber = {
	/** `ER_CHECKREAD`: a record changed after the read view of a transaction (`innodb_snapshot_isolation=ON`). */
	CheckRead: 1020,
	/** `ER_BAD_FIELD_ERROR`: an unknown column, such as `global_position` on a 3.x table. */
	BadField: 1054,
	/** `ER_DUP_ENTRY`: a duplicate on a primary key or unique index. */
	DuplicateEntry: 1062,
	/** `ER_NO_SUCH_TABLE`. */
	NoSuchTable: 1146,
	/** `ER_UNKNOWN_SYSTEM_VARIABLE`, such as `@@wsrep_on` on a server without Galera. */
	UnknownSystemVariable: 1193,
	/** `ER_LOCK_WAIT_TIMEOUT`. */
	LockWaitTimeout: 1205,
	/** `ER_LOCK_DEADLOCK`. */
	Deadlock: 1213,
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
 * The name of the key a duplicate-key error names (`PRIMARY`, `ux_global_position`, ...), from its message:
 * MariaDB writes `for key 'PRIMARY'`, MySQL `for key 'table.PRIMARY'`.
 */
export const duplicateKeyOf = (error: unknown): string | undefined => {
	const message = (error as { sqlMessage?: unknown; message?: unknown } | null | undefined) ?? {};
	const text = typeof message.sqlMessage === 'string' ? message.sqlMessage : String(message.message ?? '');
	return /for key '(?:[^.']*\.)?([^']+)'/.exec(text)?.[1];
};

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
