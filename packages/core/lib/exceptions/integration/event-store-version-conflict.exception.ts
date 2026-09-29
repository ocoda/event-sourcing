import type { ExpectedVersion } from '../../constants.js';
import type { IEventPool } from '../../interfaces/index.js';
import type { EventStream } from '../../models/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when an append doesn't find the stream at the version it expected: another writer appended first, or the
 * aggregate was loaded from a stale state. Nothing of the append was stored. Reload the aggregate and retry.
 *
 * Match on the `code` (`EventSourcingErrorCode.EventStoreVersionConflict`) and the fields, not on the message.
 */
export class EventStoreVersionConflictException extends EventSourcingError {
	override readonly name = 'EventStoreVersionConflictException';
	readonly code = EventSourcingErrorCode.EventStoreVersionConflict;
	readonly streamId: string;
	readonly aggregateId: string;
	readonly pool?: IEventPool;
	/** The version the stream was expected to have before the append. */
	readonly expectedVersion: ExpectedVersion;
	/** The version the stream had instead. Unknown when the append lost a race on the unique (stream, version) key. */
	readonly actualVersion?: number;

	constructor(
		details: { stream: EventStream; expectedVersion: ExpectedVersion; actualVersion?: number; pool?: IEventPool },
		options?: ErrorOptions,
	) {
		const streamId = details?.stream?.streamId;
		const actual =
			details?.actualVersion === undefined
				? 'another append took the version first'
				: `but the stream is at version ${details.actualVersion}`;
		super(
			`Appending to the ${streamId} stream${details?.pool ? ` of the ${details.pool} pool` : ''} failed due to a version conflict: expected version ${details?.expectedVersion}, ${actual}.`,
			options,
		);
		this.streamId = streamId;
		this.aggregateId = details?.stream?.aggregateId;
		this.pool = details?.pool;
		this.expectedVersion = details?.expectedVersion;
		this.actualVersion = details?.actualVersion;
	}
}
