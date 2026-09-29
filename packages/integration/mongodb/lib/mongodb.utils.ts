import { setTimeout as sleep } from 'node:timers/promises';
import type { AbstractCursor, ClientSession } from 'mongodb';

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
 * A single write reports the key pattern. A bulk write (`insertMany`) only has the message
 * (`… index: streamId_1_version_1 dup key: { streamId: "…", version: 2 }`), whose values the server doesn't escape (a
 * stream id may hold quotes, commas, colons and newlines), so the index is recognized by its name, which the stores
 * (and 3.x) always leave at the default; the key's fields are only parsed for an index with another name.
 */
export type DuplicateKey = 'stream-version' | 'id' | 'position' | 'latest' | 'other';

/** The unique indexes of the stores by name: the default names of their keys, and the latest flag's own name. */
const DUPLICATE_KEY_BY_INDEX: Readonly<Record<string, DuplicateKey>> = {
	_id_: 'id',
	streamId_1_version_1: 'stream-version',
	globalPosition_1: 'position',
	latest_unique: 'latest',
};

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
	let fields: string[];
	if (candidate?.keyPattern) {
		fields = Object.keys(candidate.keyPattern);
	} else {
		const message = [
			candidate?.writeErrors?.find(({ code }) => code === DUPLICATE_KEY_ERROR_CODE)?.errmsg,
			candidate?.errmsg,
			candidate?.message,
		].find((text): text is string => typeof text === 'string' && text.includes('dup key'));
		const index = message?.match(/ index: (\S+) dup key: /)?.[1];
		if (index !== undefined && Object.hasOwn(DUPLICATE_KEY_BY_INDEX, index)) {
			return DUPLICATE_KEY_BY_INDEX[index];
		}
		fields = fieldsOfMessage(message);
	}
	const has = (...names: string[]) => names.length === fields.length && names.every((name) => fields.includes(name));
	if (has('streamId', 'version')) return 'stream-version';
	if (has('_id')) return 'id';
	if (has('globalPosition')) return 'position';
	if (has('aggregateName', 'latest')) return 'latest';
	return 'other';
};

const fieldsOfMessage = (message: string | undefined): string[] => {
	const key = message?.match(/dup key: \{([\s\S]*)\}/)?.[1];
	if (!key) {
		return [];
	}
	// The values are quoted strings or numbers; drop the strings, which may hold commas and colons themselves
	const withoutStrings = key.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	return [...withoutStrings.matchAll(/(?:^|,)\s*([^:,\s]+)\s*:/g)].map(([, field]) => field);
};

/**
 * The options of an append's transaction: snapshot reads and majority writes on the primary, and a commit that waits
 * for the majority at most until the append's deadline (at least a second), so that an append can't hang on a replica
 * set that lost its majority; such a commit ends with an unknown result.
 */
export const transactionOptions = (deadline: number) =>
	({
		readConcern: { level: 'snapshot' },
		writeConcern: { w: 'majority' },
		readPreference: 'primary',
		maxCommitTimeMS: Math.max(1_000, deadline - Date.now()),
	}) as const;

/**
 * Commits, retrying a commit whose result is unknown (a network error, a failover or a commit timeout) up to
 * `APPEND_LIMITS.commitRetries` times; the server commits a transaction at most once.
 */
export const commitWithRetries = async (session: ClientSession): Promise<void> => {
	for (let retry = 0; ; retry++) {
		try {
			await session.commitTransaction();
			return;
		} catch (error) {
			if (retry < APPEND_LIMITS.commitRetries && hasErrorLabel(error, 'UnknownTransactionCommitResult')) {
				continue;
			}
			throw error;
		}
	}
};

/** The client options that bound how long one operation may take. */
const OPERATION_TIMEOUTS = ['timeoutMS', 'socketTimeoutMS'] as const;

/**
 * The config of a store that only migrates: the application's config without the client timeouts that bound one
 * operation (in the options or in the connection string), because the numbering and an index build are single
 * operations that run for minutes on a large collection. A timeout would leave the collection fenced and partly
 * migrated on every run.
 */
export const withoutOperationTimeouts = <C extends { url: string; timeoutMS?: number; socketTimeoutMS?: number }>(
	config: C,
): C => {
	const { timeoutMS: _timeoutMS, socketTimeoutMS: _socketTimeoutMS, ...rest } = config;
	return { ...rest, url: withoutUrlOptions(config.url, OPERATION_TIMEOUTS), socketTimeoutMS: 0 } as C;
};

/** The connection string without the given options (URI option names are case-insensitive). */
const withoutUrlOptions = (url: string, names: readonly string[]): string => {
	const start = url.indexOf('?');
	if (start === -1) {
		return url;
	}
	const dropped = new Set(names.map((name) => name.toLowerCase()));
	const kept = url
		.slice(start + 1)
		.split('&')
		.filter((option) => option !== '' && !dropped.has(option.split('=')[0].toLowerCase()));
	return kept.length > 0 ? `${url.slice(0, start)}?${kept.join('&')}` : url.slice(0, start);
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
