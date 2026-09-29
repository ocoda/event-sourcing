import type { ISnapshotCollection } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when a snapshot store fails to append a snapshot for another reason than a version conflict. The underlying
 * error is the `cause`.
 */
export class SnapshotStorePersistenceException extends EventSourcingError {
	override readonly name = 'SnapshotStorePersistenceException';
	readonly code = EventSourcingErrorCode.SnapshotStorePersistence;
	readonly collection: ISnapshotCollection;

	constructor(details: { collection: ISnapshotCollection }, options?: ErrorOptions) {
		super(`An error occurred while appending snapshot to the ${details?.collection} collection.`, options);
		this.collection = details?.collection;
	}
}
