import type { ISnapshotCollection } from '../../interfaces';

/**
 * Represents an exception that occurs while persisting snapshots to the snapshot store.
 * @extends {Error}
 */
export class SnapshotStorePersistenceException extends Error {
	constructor(collection: ISnapshotCollection, { stack }: Error) {
		super(`An error occurred while appending snapshot to the ${collection} collection.`);
		this.stack = stack;
	}
}
