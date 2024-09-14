import { EventStoreClient } from '../../interfaces/integration';

export class MissingStoreConnectionOptionsException extends Error {
	constructor(store: 'eventStore' | 'snapshotStore', type: Omit<EventStoreClient, 'in-memory'>) {
		super(`No ${type} connection options provided for the ${store}`);
	}
}
