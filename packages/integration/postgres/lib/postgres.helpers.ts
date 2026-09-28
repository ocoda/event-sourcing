import { createHash } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { type Pool, type PoolClient, escapeIdentifier } from 'pg';
import Cursor from 'pg-cursor';

/**
 * SQLSTATE raised when a unique constraint is violated.
 */
export const UNIQUE_VIOLATION = '23505';

/**
 * SQLSTATE raised when the current role lacks a privilege.
 */
export const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Postgres truncates identifiers longer than NAMEDATALEN - 1 bytes.
 */
const MAX_IDENTIFIER_BYTES = 63;

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
		await client.query('BEGIN');
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

export interface PostgresTableDefinition {
	/**
	 * The (unescaped) name of the table.
	 */
	table: string;
	/**
	 * The column and constraint definitions of the table.
	 */
	definition: string;
	/**
	 * The secondary index of the table.
	 */
	index: { suffix: string; columns: [string, string] };
}

/**
 * Creates a table and its secondary index if they don't exist yet.
 *
 * The DDL runs in a single transaction, guarded by an advisory lock on the table name,
 * so application instances that boot at the same time don't race each other.
 *
 * The secondary index is only created together with the table. When an existing table lacks it,
 * a warning with the statement to create it is logged instead, because building an index
 * on a large table blocks writes to it.
 */
export const ensureTable = async (
	pool: Pool,
	logger: Pick<LoggerService, 'warn'>,
	{ table, definition, index }: PostgresTableDefinition,
): Promise<void> => {
	const tableIdentifier = escapeIdentifier(table);
	const indexIdentifier = escapeIdentifier(deriveIndexName(table, index.suffix));
	const indexColumns = index.columns.join(', ');
	const createIndexStatement = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexIdentifier} ON ${tableIdentifier} (${indexColumns})`;

	await withTransaction(pool, async (client) => {
		await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);

		const {
			rows: [{ existed }],
		} = await client.query<{ existed: boolean }>(
			`SELECT to_regclass(format('%I.%I', current_schema(), $1::text)) IS NOT NULL AS existed`,
			[table],
		);

		if (!existed) {
			await client.query(`CREATE TABLE IF NOT EXISTS ${tableIdentifier} (${definition})`);
		}

		// Any valid, non-partial btree index that leads with the indexed columns will do, whatever its name
		const {
			rows: [{ indexed }],
		} = await client.query<{ indexed: boolean }>(
			`SELECT EXISTS (
				SELECT 1
				FROM pg_index i
				JOIN pg_class ic ON ic.oid = i.indexrelid
				JOIN pg_am am ON am.oid = ic.relam
				JOIN pg_attribute a1 ON a1.attrelid = i.indrelid AND a1.attnum = i.indkey[0]
				JOIN pg_attribute a2 ON a2.attrelid = i.indrelid AND a2.attnum = i.indkey[1]
				WHERE i.indrelid = to_regclass(format('%I.%I', current_schema(), $1::text))
				AND i.indisvalid
				AND i.indpred IS NULL
				AND i.indnkeyatts >= 2
				AND am.amname = 'btree'
				AND a1.attname = $2
				AND a2.attname = $3
			) AS indexed`,
			[table, ...index.columns],
		);

		if (indexed) {
			return;
		}

		if (existed) {
			logger.warn(
				`Collection ${tableIdentifier} has no index on (${indexColumns}). It isn't created automatically because building it blocks writes to the existing table, create it with: ${createIndexStatement};`,
			);
			return;
		}

		await client.query('SAVEPOINT create_index');
		try {
			await client.query(`CREATE INDEX IF NOT EXISTS ${indexIdentifier} ON ${tableIdentifier} (${indexColumns})`);
			await client.query('RELEASE SAVEPOINT create_index');
		} catch (error) {
			if (!hasErrorCode(error, INSUFFICIENT_PRIVILEGE)) {
				throw error;
			}
			await client.query('ROLLBACK TO SAVEPOINT create_index');
			logger.warn(
				`Collection ${tableIdentifier} has no index on (${indexColumns}) because the current role isn't allowed to create it, create it with: ${createIndexStatement};`,
			);
		}
	});
};
