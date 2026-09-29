import type { ISnapshotCollection } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when a snapshot store fails to create a collection (a table, for the SQL stores). The underlying error is
 * the `cause`.
 */
export class SnapshotStoreCollectionCreationException extends EventSourcingError {
	override readonly name = 'SnapshotStoreCollectionCreationException';
	readonly code = EventSourcingErrorCode.SnapshotStoreCollectionCreation;
	readonly collection: ISnapshotCollection;

	constructor(details: { collection: ISnapshotCollection }, options?: ErrorOptions) {
		super(`An error occurred while creating the ${details?.collection} collection.`, options);
		this.collection = details?.collection;
	}
}
