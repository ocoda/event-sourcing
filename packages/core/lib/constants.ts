export const EVENT_SOURCING_OPTIONS = 'EventSourcingModuleOptions';

export enum StreamReadingDirection {
	FORWARD = 0,
	BACKWARD = 1,
}

export const DEFAULT_BATCH_SIZE = 100;

/**
 * The version a stream is expected to have before an append: a number (`NoStream`, 0, for a stream without events)
 * or `Any` to skip the check.
 */
export const ExpectedVersion = { NoStream: 0, Any: 'any' } as const;
export type ExpectedVersion = number | typeof ExpectedVersion.Any;

/**
 * How often an append with `ExpectedVersion.Any` is tried when concurrent appends to the same stream keep taking its
 * versions. An append loses at most once per competing commit, so this covers 16 concurrent writers per stream.
 */
export const ANY_MAX_ATTEMPTS = 16;
