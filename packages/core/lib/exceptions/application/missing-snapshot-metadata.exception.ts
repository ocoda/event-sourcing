import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a snapshot repository has no `@Snapshot()` metadata.
 */
export class MissingSnapshotMetadataException extends EventSourcingError {
	override readonly name = 'MissingSnapshotMetadataException';
	readonly code = EventSourcingErrorCode.MissingSnapshotMetadata;
	/** The class name of the snapshot repository. */
	readonly repositoryName?: string;

	constructor(details: { repository: Function | string }, options?: ErrorOptions) {
		const repositoryName = nameOf(details?.repository);
		super(
			`Missing snapshot metadata exception for ${repositoryName ?? 'unknown'}. (missing @Snapshot() decorator?)`,
			options,
		);
		this.repositoryName = repositoryName;
	}
}
