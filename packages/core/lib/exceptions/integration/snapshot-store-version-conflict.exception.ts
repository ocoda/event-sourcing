import type { SnapshotStream } from '../../models';

/**
 * Represents an exception that occurs when the snapshot being persisted
 * has a version lower that the latest version present.
 * @extends {Error}
 */
export class SnapshotStoreVersionConflictException extends Error {
	constructor({ streamId }: SnapshotStream, snapshotVersion: number, latestVersion: number, error?: Error) {
		super(
			`Appending snapshot to the ${streamId} stream failed due to a version conflict. Expected to append version ${snapshotVersion}, but latest is ${latestVersion}.`,
		);
		this.stack = error?.stack;
	}
}
