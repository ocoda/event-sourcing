import type { ISnapshotCollection } from '../../interfaces/aggregate/snapshot-collection.type';

export class SnapshotStorePersistenceException extends Error {
	constructor(collection: ISnapshotCollection, { stack }: Error) {
		super(`An error occurred while appending snapshot to the ${collection} collection.`);
		this.stack = stack;
	}
}
