import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Why an append rejected the metadata of its events:
 * - `'invalid-type'`: the correlation or causation id is not a string, or the headers are not a plain object.
 * - `'empty-key'`: a header key is empty.
 * - `'reserved-key'`: a header key starts with `$`, which is reserved for the library.
 * - `'invalid-value'`: a header value is not a string, a finite number, a boolean or `null`.
 * - `'too-long'`: the correlation or causation id is longer than `limit` characters.
 * - `'too-large'`: the JSON of the headers is larger than `limit` bytes (UTF-8).
 */
export type InvalidEventMetadataReason =
	| 'invalid-type'
	| 'empty-key'
	| 'reserved-key'
	| 'invalid-value'
	| 'too-long'
	| 'too-large';

/**
 * Thrown when the correlation id, the causation id or the headers of an append (from its options or from a pre-built
 * envelope) are invalid. Nothing was written.
 */
export class InvalidEventMetadataException extends EventSourcingError {
	override readonly name = 'InvalidEventMetadataException';
	readonly code = EventSourcingErrorCode.InvalidEventMetadata;
	/** The metadata field: `'correlationId'`, `'causationId'` or `'headers'`. */
	readonly field: string;
	readonly reason: InvalidEventMetadataReason;
	/** The offending header key, for the reasons about a single header. */
	readonly key?: string;
	/** The maximum length (`'too-long'`) or size in bytes (`'too-large'`). */
	readonly limit?: number;

	constructor(
		details: { field: string; reason: InvalidEventMetadataReason; key?: string; limit?: number },
		options?: ErrorOptions,
	) {
		super(messageOf(details), options);
		this.field = details?.field;
		this.reason = details?.reason;
		this.key = details?.key;
		this.limit = details?.limit;
	}
}

const messageOf = (details: ConstructorParameters<typeof InvalidEventMetadataException>[0]): string => {
	const field = details?.field ?? 'metadata';
	const key = JSON.stringify(details?.key ?? '');
	switch (details?.reason) {
		case 'invalid-type':
			return `Invalid event metadata: ${field} must be ${field === 'headers' ? 'a plain object' : 'a string'}.`;
		case 'empty-key':
			return `Invalid event metadata: ${field} has an empty key.`;
		case 'reserved-key':
			return `Invalid event metadata: the ${field} key ${key} is reserved; keys that start with $ are reserved for the library.`;
		case 'invalid-value':
			return `Invalid event metadata: the value of the ${field} key ${key} must be a string, a finite number, a boolean or null.`;
		case 'too-long':
			return `Invalid event metadata: ${field} is longer than ${details.limit ?? 'the maximum of'} characters.`;
		case 'too-large':
			return `Invalid event metadata: ${field} are larger than ${details.limit ?? 'the maximum of'} bytes as JSON.`;
		default:
			return `Invalid event metadata: ${field}.`;
	}
};
