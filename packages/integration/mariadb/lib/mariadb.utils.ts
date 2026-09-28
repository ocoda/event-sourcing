import type { Readable } from 'node:stream';
import type { Pool } from 'mariadb';

/** MariaDB / MySQL error number for a violated PRIMARY KEY or UNIQUE constraint (`ER_DUP_ENTRY`). */
const ER_DUP_ENTRY = 1062;

/**
 * Whether an error thrown by the `mariadb` connector is a duplicate-key violation.
 * Used to translate a lost optimistic-concurrency race into a version conflict.
 */
export const isDuplicateEntryError = (error: unknown): boolean => {
	const { errno, code } = (error ?? {}) as { errno?: unknown; code?: unknown };
	return errno === ER_DUP_ENTRY || code === 'ER_DUP_ENTRY';
};

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
