import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Why an append rejected an envelope:
 * - `'aggregate-id'`: a pre-built envelope belongs to another aggregate than the stream.
 * - `'version'`: the versions of the appended items don't continue the stream from the expected version.
 * - `'expected-version-any'`: pre-built envelopes were appended with `ExpectedVersion.Any`.
 * - `'too-long'`: the stream id, aggregate id or event name is longer than the stores allow.
 */
export type InvalidEventEnvelopeReason = 'aggregate-id' | 'version' | 'expected-version-any' | 'too-long';

/**
 * Thrown when an append can't store what it was given, before anything is written.
 *
 * Pre-built envelopes (imports, copies from another store) are stored with their own id and time, so they have to
 * belong to the stream's aggregate and continue the stream exactly: the item at index `i` has version
 * `expectedVersion + 1 + i`. That needs a numeric expected version.
 */
export class InvalidEventEnvelopeException extends EventSourcingError {
	override readonly name = 'InvalidEventEnvelopeException';
	readonly code = EventSourcingErrorCode.InvalidEventEnvelope;
	readonly streamId: string;
	/** The index of the item in the appended array, when a single item is at fault. */
	readonly index?: number;
	readonly reason: InvalidEventEnvelopeReason;
	/** For `'too-long'`: the value that is too long. `'event'` is the event name (`EVENT_STORE_LIMITS.eventName`). */
	readonly field?: 'streamId' | 'aggregateId' | 'event';
	/** The aggregate id, version or maximum length that was expected. */
	readonly expected?: string | number;
	/** The aggregate id, version or length that was found instead. */
	readonly actual?: string | number;

	constructor(
		details: {
			streamId: string;
			index?: number;
			reason: InvalidEventEnvelopeReason;
			field?: 'streamId' | 'aggregateId' | 'event';
			expected?: string | number;
			actual?: string | number;
		},
		options?: ErrorOptions,
	) {
		super(messageOf(details), options);
		this.streamId = details?.streamId;
		this.index = details?.index;
		this.reason = details?.reason;
		this.field = details?.field;
		this.expected = details?.expected;
		this.actual = details?.actual;
	}
}

const messageOf = (details: ConstructorParameters<typeof InvalidEventEnvelopeException>[0]): string => {
	const stream = `the ${details?.streamId ?? 'unknown'} stream`;
	const item = details?.index === undefined ? 'An envelope' : `The item at index ${details.index}`;
	switch (details?.reason) {
		case 'aggregate-id':
			return `${item} belongs to aggregate ${details.actual}, not to aggregate ${details.expected} of ${stream}.`;
		case 'version':
			return `${item} has version ${details.actual}, but the append continues ${stream} at version ${details.expected}.`;
		case 'expected-version-any':
			return `Pre-built envelopes can't be appended to ${stream} with ExpectedVersion.Any: pass the version of the stream before the append.`;
		case 'too-long':
			return `The ${details.field ?? 'value'} of ${details.index === undefined ? 'an append' : `the item at index ${details.index}`} to ${stream} is ${details.actual} characters long, the maximum is ${details.expected}.`;
		default:
			return `Invalid envelope for ${stream}.`;
	}
};
