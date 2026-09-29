import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import Cursor from 'pg-cursor';

/**
 * SQLSTATE raised when a unique constraint is violated.
 */
export const UNIQUE_VIOLATION = '23505';

/**
 * SQLSTATE raised when a table (relation) doesn't exist.
 */
export const UNDEFINED_TABLE = '42P01';

/**
 * SQLSTATE raised when a column doesn't exist, such as `global_position` in a 3.x table.
 */
export const UNDEFINED_COLUMN = '42703';

/**
 * SQLSTATE raised when a lock can't be taken within `lock_timeout`.
 */
export const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Postgres truncates identifiers longer than NAMEDATALEN - 1 bytes.
 */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * The largest number of rows a single fetch from a cursor can request.
 */
const MAX_INT32 = 2 ** 31 - 1;

/**
 * Checks whether an error was raised by Postgres with the given SQLSTATE.
 */
export const hasErrorCode = (error: unknown, code: string): boolean =>
	typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;

/**
 * Derives the name of a secondary index from the name of the table it belongs to.
 * Names that don't fit in a Postgres identifier are truncated and suffixed with a hash of the full name,
 * so indexes of tables that share a long prefix still get distinct names.
 */
export const deriveIndexName = (table: string, suffix: string): string => {
	const name = `idx_${table}_${suffix}`;

	if (Buffer.byteLength(name) <= MAX_IDENTIFIER_BYTES) {
		return name;
	}

	const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
	const maxPrefixBytes = MAX_IDENTIFIER_BYTES - hash.length - 1;

	let prefix = '';
	for (const character of name) {
		if (Buffer.byteLength(prefix + character) > maxPrefixBytes) {
			break;
		}
		prefix += character;
	}

	return `${prefix}_${hash}`;
};

/**
 * Runs the given work in a transaction on a dedicated client.
 * The transaction is rolled back when the work fails and the client is always returned to the pool.
 *
 * The isolation level is explicitly READ COMMITTED, whatever the server's default: the work serializes on locks (an
 * advisory lock, a counter row) and has to see what the transaction it waited for committed. Under REPEATABLE READ or
 * SERIALIZABLE it would fail with serialization errors (40001) instead.
 */
export const withTransaction = async <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> => {
	const client = await pool.connect();

	// A failing connection emits an error on the client, which would crash the process without a listener
	let failure: Error | undefined;
	const onError = (error: Error) => {
		failure ??= error;
	};
	client.on('error', onError);

	let began = false;
	try {
		await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
		began = true;

		const result = await work(client);
		await client.query('COMMIT');

		return result;
	} catch (error) {
		if (began && !failure) {
			try {
				await client.query('ROLLBACK');
			} catch (rollbackError) {
				failure = rollbackError;
			}
		}
		throw error;
	} finally {
		client.removeListener('error', onError);
		// Releasing with an error discards the client instead of returning a broken connection to the pool
		client.release(failure);
	}
};

/**
 * Streams the rows of a query in batches using a server-side cursor on a dedicated client.
 * The cursor is closed and the client returned to the pool however the iteration ends
 * (fully consumed, exited early, or failed), so an interrupted read never blocks other queries.
 *
 * Once the last rows have been read, the client is returned to the pool before they are handed out.
 * The consumer can then call the store while it processes them without needing a second connection,
 * and a read that is never finished doesn't hold on to a connection when its rows fit in one batch.
 */
export async function* readInBatches<Row>(
	pool: Pool,
	query: string,
	values: unknown[],
	batch: number,
): AsyncGenerator<Row[]> {
	const client = await pool.connect();

	let failure: Error | undefined;
	let onFailure: () => void = () => {};
	const onError = (error: Error) => {
		failure ??= error;
		onFailure();
	};
	client.on('error', onError);

	let released = false;
	const release = () => {
		if (released) {
			return;
		}
		released = true;
		client.removeListener('error', onError);
		// Releasing with an error discards the client instead of returning a broken connection to the pool
		client.release(failure);
	};

	// Postgres only returns fewer rows than requested once the query completed, after which the cursor's portal is closed.
	// Batch sizes that don't fit a positive int32 aren't sent as is, so for those only an empty batch marks the end.
	const isLastBatch = (rows: Row[]) =>
		rows.length === 0 || (Number.isInteger(batch) && batch > 0 && batch <= MAX_INT32 && rows.length < batch);

	try {
		const cursor = client.query(new Cursor<Row>(query, values));
		cursor.on('error', onError);

		let exhausted = false;
		try {
			while (!exhausted) {
				const rows = await cursor.read(batch);

				if (isLastBatch(rows)) {
					exhausted = true;
					release();
				}

				if (rows.length > 0) {
					yield rows;
				}
			}
		} finally {
			// An exhausted cursor has nothing left to close, and a failed one has already ended its portal (or lost its connection)
			if (!exhausted && !failure) {
				await Promise.race([
					new Promise<void>((resolve, reject) => cursor.close((error) => (error ? reject(error) : resolve()))),
					new Promise<void>((resolve) => {
						onFailure = resolve;
					}),
				]).catch(onError);
			}
		}
	} finally {
		release();
	}
}
