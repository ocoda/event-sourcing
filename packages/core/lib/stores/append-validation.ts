/**
 * The checks an append runs before any I/O. Pure functions: they throw the library exception for the first problem
 * they find and return nothing else of note.
 */
import { ExpectedVersion } from '../constants.js';
import {
	InvalidAppendOptionsException,
	InvalidEventEnvelopeException,
	InvalidEventMetadataException,
	UnsupportedOperationException,
} from '../exceptions/index.js';
import type { EventStoreCapabilities, IEventPool } from '../interfaces/index.js';
import { EventEnvelope, type EventStream } from '../models/index.js';

/**
 * The largest values every event store accepts. Appends are checked against them before any I/O, and the stores size
 * their columns to match. Lengths count characters (Unicode code points); `headersBytes` counts the UTF-8 bytes of the
 * JSON of the headers.
 */
export const EVENT_STORE_LIMITS = Object.freeze({
	streamId: 255,
	aggregateId: 255,
	eventName: 255,
	correlationId: 255,
	causationId: 255,
	headersBytes: 8192,
} as const);

const codePoints = (value: string): number => {
	let count = 0;
	for (const _ of value) {
		count++;
	}
	return count;
};

/**
 * The length of the string in characters when it is longer than the limit, otherwise undefined.
 */
const lengthOver = (value: string, limit: number): number | undefined => {
	// A string has at least as many UTF-16 code units as code points, so short strings need no count.
	if (value.length <= limit) {
		return undefined;
	}
	const length = codePoints(value);
	return length > limit ? length : undefined;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (!isObject(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

const isHeaderValue = (value: unknown): boolean =>
	value === null ||
	typeof value === 'string' ||
	typeof value === 'boolean' ||
	(typeof value === 'number' && Number.isFinite(value));

/**
 * Checks the expected version of an append: a safe integer of at least 0, or `ExpectedVersion.Any`.
 * @throws InvalidAppendOptionsException
 */
export const validateExpectedVersion = (expectedVersion: unknown): ExpectedVersion => {
	if (expectedVersion === ExpectedVersion.Any) {
		return expectedVersion;
	}
	if (typeof expectedVersion === 'number' && Number.isSafeInteger(expectedVersion) && expectedVersion >= 0) {
		// Normalizes -0
		return expectedVersion === 0 ? 0 : expectedVersion;
	}
	throw new InvalidAppendOptionsException({
		option: 'expectedVersion',
		value: expectedVersion,
		reason: 'must be a safe integer of at least 0 (ExpectedVersion.NoStream for a new stream) or ExpectedVersion.Any',
	});
};

/**
 * Checks the pool of an append: a non-empty string, or `undefined` (or `null`) for the default pool.
 * @throws InvalidAppendOptionsException
 */
export const validatePool = (pool: unknown): IEventPool | undefined => {
	if (pool === undefined || pool === null) {
		return undefined;
	}
	if (typeof pool === 'string' && pool.length > 0) {
		return pool;
	}
	throw new InvalidAppendOptionsException({
		option: 'pool',
		value: pool,
		reason: 'must be a non-empty string, or undefined for the default pool',
	});
};

const validateId = (field: 'correlationId' | 'causationId', value: unknown): void => {
	if (value === undefined || value === null) {
		return;
	}
	if (typeof value !== 'string') {
		throw new InvalidEventMetadataException({ field, reason: 'invalid-type' });
	}
	const limit = EVENT_STORE_LIMITS[field];
	if (lengthOver(value, limit) !== undefined) {
		throw new InvalidEventMetadataException({ field, reason: 'too-long', limit });
	}
};

const validateHeaders = (
	headers: unknown,
	capabilities: Pick<EventStoreCapabilities, 'headers'> | undefined,
	options: AppendMetadataValidationOptions,
): void => {
	if (headers === undefined || headers === null) {
		return;
	}
	if (!isPlainObject(headers)) {
		throw new InvalidEventMetadataException({ field: 'headers', reason: 'invalid-type' });
	}
	const keys = Object.keys(headers);
	if (keys.length === 0) {
		return;
	}
	for (const key of keys) {
		if (key === '') {
			throw new InvalidEventMetadataException({ field: 'headers', reason: 'empty-key', key });
		}
		if (!options.allowReservedKeys && key.startsWith('$')) {
			throw new InvalidEventMetadataException({ field: 'headers', reason: 'reserved-key', key });
		}
		if (!isHeaderValue(headers[key])) {
			throw new InvalidEventMetadataException({ field: 'headers', reason: 'invalid-value', key });
		}
	}
	if (Buffer.byteLength(JSON.stringify(headers), 'utf8') > EVENT_STORE_LIMITS.headersBytes) {
		throw new InvalidEventMetadataException({
			field: 'headers',
			reason: 'too-large',
			limit: EVENT_STORE_LIMITS.headersBytes,
		});
	}
	// Last, so that invalid headers get the same InvalidEventMetadataException from every store
	if (capabilities?.headers !== true) {
		throw new UnsupportedOperationException({ operation: 'headers', component: options.component ?? 'event store' });
	}
};

export interface AppendMetadataValidationOptions {
	/**
	 * Allow header keys that start with `$`. Only the headers of pre-built envelopes may have them (an import keeps its
	 * `$traceparent`); the metadata of the append options may not.
	 * @default false
	 */
	allowReservedKeys?: boolean;
	/**
	 * The name of the store, for the `UnsupportedOperationException` of a store without headers.
	 * @default 'event store'
	 */
	component?: string;
}

/**
 * Checks the metadata of an append, or of a pre-built envelope:
 * - `correlationId` and `causationId` are strings of at most 255 characters (`null` counts as absent);
 * - `headers` is a plain object with non-empty keys that don't start with `$` (unless `allowReservedKeys`), whose values
 *   are strings, finite numbers, booleans or `null`, and whose JSON is at most 8 KiB (UTF-8). `allowReservedKeys` lifts
 *   only the `$` rule;
 * - a store without the `headers` capability gets no headers: valid, non-empty headers then throw an
 *   `UnsupportedOperationException`. Headers are checked first, so invalid headers throw the same
 *   `InvalidEventMetadataException` on every store. Empty headers (`{}`) carry nothing and pass.
 *
 * @throws InvalidAppendOptionsException when the metadata is not an object
 * @throws InvalidEventMetadataException
 * @throws UnsupportedOperationException
 */
export const validateAppendMetadata = (
	metadata: unknown,
	capabilities: Pick<EventStoreCapabilities, 'headers'> | undefined,
	options: AppendMetadataValidationOptions = {},
): void => {
	if (metadata === undefined || metadata === null) {
		return;
	}
	if (!isObject(metadata)) {
		throw new InvalidAppendOptionsException({
			option: 'metadata',
			value: metadata,
			reason: 'must be an object with a correlationId, causationId or headers',
		});
	}
	validateId('correlationId', metadata.correlationId);
	validateId('causationId', metadata.causationId);
	validateHeaders(metadata.headers, capabilities, options);
};

/**
 * Checks the stream id, the aggregate id and the event name of every envelope of an append against
 * {@link EVENT_STORE_LIMITS}.
 * @throws InvalidEventEnvelopeException with the reason `'too-long'`
 */
export const validateEnvelopeLimits = (stream: EventStream, envelopes: readonly { readonly event: string }[]): void => {
	const tooLong = (
		field: 'streamId' | 'aggregateId' | 'event',
		value: string,
		limit: number,
		index?: number,
	): InvalidEventEnvelopeException | undefined => {
		const length = typeof value === 'string' ? lengthOver(value, limit) : undefined;
		return length === undefined
			? undefined
			: new InvalidEventEnvelopeException({
					streamId: stream.streamId,
					index,
					reason: 'too-long',
					field,
					expected: limit,
					actual: length,
				});
	};

	const error =
		tooLong('streamId', stream.streamId, EVENT_STORE_LIMITS.streamId) ??
		tooLong('aggregateId', stream.aggregateId, EVENT_STORE_LIMITS.aggregateId);
	if (error) {
		throw error;
	}
	for (const [index, envelope] of envelopes.entries()) {
		const eventError = tooLong('event', envelope.event, EVENT_STORE_LIMITS.eventName, index);
		if (eventError) {
			throw eventError;
		}
	}
};

/**
 * Checks the pre-built envelopes among the items of an append. They are stored as they are, so they need a numeric
 * expected version, have to belong to the stream's aggregate, and the item at index `i` (raw events count too) has to
 * have version `expectedVersion + 1 + i`. Their metadata is checked separately, with `validateAppendMetadata`.
 *
 * Expects an expected version that passed `validateExpectedVersion`.
 * @throws InvalidEventEnvelopeException
 */
export const validatePrebuiltEnvelopes = (
	stream: EventStream,
	items: readonly unknown[],
	expectedVersion: ExpectedVersion,
): void => {
	for (const [index, item] of items.entries()) {
		if (!(item instanceof EventEnvelope)) {
			continue;
		}
		if (expectedVersion === ExpectedVersion.Any) {
			throw new InvalidEventEnvelopeException({ streamId: stream.streamId, index, reason: 'expected-version-any' });
		}
		const aggregateId = item.metadata?.aggregateId;
		const version = item.metadata?.version;
		if (aggregateId !== stream.aggregateId) {
			throw new InvalidEventEnvelopeException({
				streamId: stream.streamId,
				index,
				reason: 'aggregate-id',
				expected: stream.aggregateId,
				actual: aggregateId,
			});
		}
		if (version !== expectedVersion + 1 + index) {
			throw new InvalidEventEnvelopeException({
				streamId: stream.streamId,
				index,
				reason: 'version',
				expected: expectedVersion + 1 + index,
				actual: version,
			});
		}
	}
};
