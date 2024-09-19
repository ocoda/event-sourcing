import type { IEventCollection } from '../../interfaces/events/event-collection.type';

export class EventStorePersistenceException extends Error {
	constructor(collection: IEventCollection, { stack }: Error) {
		super(`An error occurred while appending events to the ${collection} collection.`);
		this.stack = stack;
	}
}
