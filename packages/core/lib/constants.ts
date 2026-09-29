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
