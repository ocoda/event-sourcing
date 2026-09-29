import type { ISnapshotPool } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when a stream has no snapshot at the requested version.
 */
export class SnapshotNotFoundException extends EventSourcingError {
	override readonly name = 'SnapshotNotFoundException';
	readonly code = EventSourcingErrorCode.SnapshotNotFound;
	readonly streamId: string;
	readonly version: number;
	readonly pool?: ISnapshotPool;

	constructor(details: { streamId: string; version: number; pool?: ISnapshotPool }, options?: ErrorOptions) {
		super(
			`Snapshot with version ${details?.version} not found in the ${details?.streamId} stream${details?.pool ? ` of the ${details.pool} pool` : ''}.`,
			options,
		);
		this.streamId = details?.streamId;
		this.version = details?.version;
		this.pool = details?.pool;
	}
}
