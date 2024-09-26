import type { ISnapshotCollection } from '../../interfaces';

/**
 * Represents an exception that occurs while creating a snapshot-store collection.
 * @extends {Error}
 */
export class SnapshotStoreCollectionCreationException extends Error {
	constructor(collection: ISnapshotCollection, { stack }: Error) {
		super(`An error occurred while creating the ${collection} collection.`);
		this.stack = stack;
	}
}
