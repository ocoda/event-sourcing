import type { IEventCollection } from '../../interfaces';

/**
 * Represents an exception that occurs while persisting events to the event store.
 * @extends {Error}
 */
export class EventStorePersistenceException extends Error {
	constructor(collection: IEventCollection, { stack }: Error) {
		super(`An error occurred while appending events to the ${collection} collection.`);
		this.stack = stack;
	}
}
