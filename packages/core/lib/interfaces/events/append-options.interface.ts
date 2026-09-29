import type { ExpectedVersion } from '../../constants.js';
import type { IEventPool } from './event-pool.type.js';

/**
 * Key-value metadata stored with an event, next to its payload: a trace id, a tenant, the user behind a change.
 *
 * Keys are non-empty; keys that start with `$` are reserved for the library (`$traceparent`, `$tenant`). Values are
 * strings, finite numbers, booleans or `null`, and the JSON of the headers of an event is at most 8 KiB (UTF-8).
 */
export type EventHeaders = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Metadata that applies to every event of an append. Pre-built envelopes keep the fields they already have; this
 * metadata only fills the fields they lack.
 */
export interface AppendMetadata {
	/**
	 * The id of the request, message or event the append originates from. At most 255 characters.
	 */
	correlationId?: string;
	/**
	 * The id of the message or event that directly caused the append. At most 255 characters.
	 */
	causationId?: string;
	/**
	 * Headers stored with each event. A store that doesn't support headers rejects them before writing anything.
	 */
	headers?: EventHeaders;
}

/**
 * The options of an append.
 */
export interface AppendOptions {
	/**
	 * The version the stream must have before the append: `ExpectedVersion.NoStream` (0) for a new stream, the version
	 * of the last event that was read, or `ExpectedVersion.Any` to append whatever the version is.
	 */
	expectedVersion: ExpectedVersion;
	/**
	 * The event pool to append to.
	 * @default the default pool
	 */
	pool?: IEventPool;
	/**
	 * The correlation id, causation id and headers of the appended events.
	 */
	metadata?: AppendMetadata;
	/**
	 * Whether to publish the appended envelopes. Set it to `false` for imports and migrations.
	 * @default true
	 */
	publish?: boolean;
}
