import type { IEventCollection } from '../../interfaces';

/**
 * Represents an exception that occurs while creating an event-store collection.
 * * @extends {Error}
 */
export class EventStoreCollectionCreationException extends Error {
	constructor(collection: IEventCollection, { stack }: Error) {
		super(`An error occurred while creating the ${collection} collection.`);
		this.stack = stack;
	}
}
