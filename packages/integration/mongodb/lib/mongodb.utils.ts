import { setTimeout as sleep } from 'node:timers/promises';
import type { AbstractCursor } from 'mongodb';

/**
 * The bounds of the appends' retries. Internal (not exported from the package); the specs shorten them.
 */
export const APPEND_LIMITS = {
	/** How long an append may retry transient transaction errors and races on a latest flag, in milliseconds. */
	transactionBudgetMs: 30_000,
	/** How often a commit whose result is unknown is retried before the append reports an `'unknown'` outcome. */
	commitRetries: 3,
};

/** Error code of a violated unique index (`DuplicateKey`). */
const DUPLICATE_KEY_ERROR_CODE = 11000;

/** Error code of `create` on a collection that exists (`NamespaceExists`). */
const NAMESPACE_EXISTS_ERROR_CODE = 48;

/**
 * Whether an error thrown by the `mongodb` driver is a duplicate-key violation (single or bulk write).
 * Used to translate a lost optimistic-concurrency race into a version conflict.
 */
export const isDuplicateKeyError = (error: unknown): boolean =>
	(error as { code?: unknown } | null | undefined)?.code === DUPLICATE_KEY_ERROR_CODE;

/** Whether `createCollection` failed because the collection exists (a concurrent creation). */
export const isNamespaceExistsError = (error: unknown): boolean =>
	(error as { code?: unknown } | null | undefined)?.code === NAMESPACE_EXISTS_ERROR_CODE;

/** Whether the driver or the server labelled an error, such as `TransientTransactionError`. */
export const hasErrorLabel = (error: unknown, label: string): boolean => {
	const candidate = error as { hasErrorLabel?: (label: string) => boolean; errorLabels?: unknown } | null | undefined;
	if (typeof candidate?.hasErrorLabel === 'function') {
		return candidate.hasErrorLabel(label);
	}
	return Array.isArray(candidate?.errorLabels) && candidate.errorLabels.includes(label);
};

/**
 * The unique key a duplicate-key error is about, by the fields of the key:
 * - `'stream-version'`: `{ streamId, version }`, another append took the version;
 * - `'id'`: `{ _id }`, the event (or snapshot) id exists;
 * - `'position'`: `{ globalPosition }`, the counter of the pool fell behind its events;
 * - `'latest'`: `{ aggregateName, latest }`, another snapshot of the stream is flagged latest;
 * - `'other'`: another unique index.
 *
 * A single write reports the key pattern; a bulk write (`insertMany`) only names it in the message
 * (`dup key: { streamId: "…", version: 2 }`), so both are read.
 */
export type DuplicateKey = 'stream-version' | 'id' | 'position' | 'latest' | 'other';

export const duplicateKeyOf = (error: unknown): DuplicateKey | undefined => {
	const candidate = error as {
		code?: unknown;
		keyPattern?: Record<string, unknown>;
		errmsg?: unknown;
		message?: unknown;
		writeErrors?: { code?: unknown; errmsg?: unknown }[];
	} | null;
	if (!isDuplicateKeyError(candidate)) {
		return undefined;
	}
	const fields = candidate?.keyPattern
		? Object.keys(candidate.keyPattern)
		: fieldsOfMessage(
				[candidate?.writeErrors?.find(({ code }) => code === DUPLICATE_KEY_ERROR_CODE)?.errmsg, candidate?.errmsg]
					.concat(candidate?.message)
					.find((message): message is string => typeof message === 'string' && message.includes('dup key')),
			);
	const has = (...names: string[]) => names.length === fields.length && names.every((name) => fields.includes(name));
	if (has('streamId', 'version')) return 'stream-version';
	if (has('_id')) return 'id';
	if (has('globalPosition')) return 'position';
	if (has('aggregateName', 'latest')) return 'latest';
	return 'other';
};

const fieldsOfMessage = (message: string | undefined): string[] => {
	const key = message?.match(/dup key: \{(.*)\}/)?.[1];
	if (!key) {
		return [];
	}
	// The values are quoted strings or numbers; drop the strings, which may hold commas and colons themselves
	const withoutStrings = key.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	return [...withoutStrings.matchAll(/(?:^|,)\s*([^:,\s]+)\s*:/g)].map(([, field]) => field);
};

/**
 * Waits a jittered backoff before a retry: `random(0, min(100, 2 ** attempt))` milliseconds, so that writers that lost
 * a race don't collide again right away.
 */
export const backoff = (attempt: number): Promise<void> => sleep(Math.random() * Math.min(100, 2 ** attempt));

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

/**
 * Yields the batches of `batches`, and calls `onEmpty` (which may throw) when there were none.
 */
export async function* ifEmpty<T>(batches: AsyncGenerator<T[]>, onEmpty: () => Promise<void>): AsyncGenerator<T[]> {
	let empty = true;
	for await (const batch of batches) {
		empty = false;
		yield batch;
	}
	if (empty) {
		await onEmpty();
	}
}
