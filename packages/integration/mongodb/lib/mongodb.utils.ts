import type { AbstractCursor } from 'mongodb';

/** Error code of a violated unique index (`DuplicateKey`). */
const DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * Whether an error thrown by the `mongodb` driver is a duplicate-key violation (single or bulk write).
 * Used to translate a lost optimistic-concurrency race into a version conflict.
 */
export const isDuplicateKeyError = (error: unknown): boolean =>
	(error as { code?: unknown } | null | undefined)?.code === DUPLICATE_KEY_ERROR_CODE;

/**
 * Reads a cursor in batches and always closes it, also when the consumer stops early (`break`, `return`)
 * or when reading fails, so that no cursor is left open on the server until it times out.
 */
export async function* batchCursor<T>(cursor: AbstractCursor<T>, batch: number): AsyncGenerator<T[]> {
	try {
		let entities: T[] = [];
		for await (const entity of cursor) {
			entities.push(entity);
			if (entities.length === batch) {
				yield entities;
				entities = [];
			}
		}
		if (entities.length > 0) {
			yield entities;
		}
	} finally {
		await cursor.close().catch(() => undefined);
	}
}
