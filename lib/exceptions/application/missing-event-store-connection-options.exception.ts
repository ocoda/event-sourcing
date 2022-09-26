export class MissingEventStoreConnectionOptionsException extends Error {
	constructor(store: 'eventStore' | 'snapshotStore', type: 'mongodb') {
		super(`No ${type} connection options provided for the ${store}`);
	}
}