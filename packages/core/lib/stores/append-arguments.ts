/**
 * Turns the arguments of `EventStore.appendEvents` into one shape, for both of its forms:
 * - `appendEvents(stream, events, { expectedVersion, pool, metadata, publish })`;
 * - the deprecated 3.x form `appendEvents(stream, aggregateVersion, events, pool?)`, where `aggregateVersion` is the
 *   version of the aggregate after the append, so the expected version is `aggregateVersion - events.length`.
 */
import type { ExpectedVersion } from '../constants.js';
import { InvalidAppendOptionsException } from '../exceptions/index.js';
import type { IEvent, IEventPool } from '../interfaces/index.js';
import type { EventEnvelope } from '../models/index.js';
import { validateExpectedVersion, validatePool } from './append-validation.js';

/**
 * What an append stores: events, which the store serializes, or pre-built envelopes, which it stores as they are.
 */
export type AppendItem = IEvent | EventEnvelope;

/**
 * The arguments of an append in either form, checked except for the metadata and the items, which the store checks
 * against its capabilities and the stream.
 */
export interface NormalizedAppend {
	items: readonly AppendItem[];
	expectedVersion: ExpectedVersion;
	pool: IEventPool | undefined;
	/** As it was passed; `validateAppendMetadata` checks it. */
	metadata: unknown;
	publish: boolean;
}

/**
 * The code of the `DeprecationWarning` that the positional form of `appendEvents` emits, once per process.
 */
export const POSITIONAL_APPEND_WARNING_CODE = 'OCODA_ES_POSITIONAL_APPEND';

let positionalAppendWarned = false;

/**
 * Emits the deprecation warning of the positional form, the first time it is used in the process.
 */
export const warnPositionalAppend = (): void => {
	if (positionalAppendWarned) {
		return;
	}
	positionalAppendWarned = true;
	process.emitWarning(
		'appendEvents(stream, aggregateVersion, events, pool) is deprecated and will be removed in 5.0. Use appendEvents(stream, events, { expectedVersion, pool }), where expectedVersion is the version of the stream before the append.',
		{ type: 'DeprecationWarning', code: POSITIONAL_APPEND_WARNING_CODE },
	);
};

/**
 * Lets the next positional append warn again. For tests only.
 * @internal
 */
export const resetPositionalAppendWarning = (): void => {
	positionalAppendWarned = false;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const toItems = (events: unknown): readonly AppendItem[] => {
	if (!Array.isArray(events)) {
		throw new InvalidAppendOptionsException({
			option: 'events',
			value: events,
			reason: 'must be an array of events and pre-built envelopes',
		});
	}
	return events;
};

/**
 * Checks and normalizes the arguments of an append (everything after the stream). The positional form is recognised by
 * a number as its first argument; it emits a `DeprecationWarning` once per process.
 *
 * @throws InvalidAppendOptionsException when the options, the expected version (or the aggregate version of the
 * positional form), the pool or `publish` are invalid, or the events are not an array
 */
export const normalizeAppendArguments = (args: readonly unknown[]): NormalizedAppend => {
	if (typeof args[0] === 'number') {
		warnPositionalAppend();
		const [aggregateVersion, events, pool] = args as [number, unknown, unknown];
		const items = toItems(events);
		if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < items.length) {
			throw new InvalidAppendOptionsException({
				option: 'aggregateVersion',
				value: aggregateVersion,
				reason: `must be a safe integer of at least the number of appended events (${items.length}): the version of the aggregate after the append`,
			});
		}
		return {
			items,
			// + 0 turns -0 into 0
			expectedVersion: aggregateVersion - items.length + 0,
			pool: validatePool(pool),
			metadata: undefined,
			publish: true,
		};
	}

	const [events, options] = args;
	const items = toItems(events);
	if (!isObject(options)) {
		throw new InvalidAppendOptionsException({
			option: 'options',
			value: options,
			reason: 'must be an object with an expectedVersion (ExpectedVersion.NoStream for a new stream)',
		});
	}
	const expectedVersion = validateExpectedVersion(options.expectedVersion);
	const pool = validatePool(options.pool);
	if (options.publish !== undefined && typeof options.publish !== 'boolean') {
		throw new InvalidAppendOptionsException({ option: 'publish', value: options.publish, reason: 'must be a boolean' });
	}
	return {
		items,
		expectedVersion,
		pool,
		metadata: options.metadata,
		publish: options.publish !== false,
	};
};
