import type { ISnapshotPool } from '../../interfaces/index.js';
import type { SnapshotStream } from '../../models/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when a snapshot is appended at or below the version of the stream's latest snapshot. Nothing was stored.
 *
 * Match on the `code` (`EventSourcingErrorCode.SnapshotStoreVersionConflict`) and the fields, not on the message.
 */
export class SnapshotStoreVersionConflictException extends EventSourcingError {
	override readonly name = 'SnapshotStoreVersionConflictException';
	readonly code = EventSourcingErrorCode.SnapshotStoreVersionConflict;
	readonly streamId: string;
	readonly aggregateId: string;
	readonly pool?: ISnapshotPool;
	/** The version of the snapshot that was appended. */
	readonly version: number;
	/** The version of the latest snapshot. Unknown when the append lost a race on the unique (stream, version) key. */
	readonly latestVersion?: number;

	constructor(
		details: { stream: SnapshotStream; version: number; latestVersion?: number; pool?: ISnapshotPool },
		options?: ErrorOptions,
	) {
		const streamId = details?.stream?.streamId;
		const latest =
			details?.latestVersion === undefined
				? 'but another append took the version first'
				: `but the latest snapshot has version ${details.latestVersion}`;
		super(
			`Appending a snapshot to the ${streamId} stream${details?.pool ? ` of the ${details.pool} pool` : ''} failed due to a version conflict: the snapshot has version ${details?.version}, ${latest}.`,
			options,
		);
		this.streamId = streamId;
		this.aggregateId = details?.stream?.aggregateId;
		this.pool = details?.pool;
		this.version = details?.version;
		this.latestVersion = details?.latestVersion;
	}
}
