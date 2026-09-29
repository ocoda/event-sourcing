import type { IEventCollection } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when an event store fails to create a collection (a table, for the SQL stores). The underlying error is the
 * `cause`.
 */
export class EventStoreCollectionCreationException extends EventSourcingError {
	override readonly name = 'EventStoreCollectionCreationException';
	readonly code = EventSourcingErrorCode.EventStoreCollectionCreation;
	readonly collection: IEventCollection;

	constructor(details: { collection: IEventCollection }, options?: ErrorOptions) {
		super(`An error occurred while creating the ${details?.collection} collection.`, options);
		this.collection = details?.collection;
	}
}
