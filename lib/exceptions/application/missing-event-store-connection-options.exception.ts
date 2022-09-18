export class MissingEventStoreConnectionOptionsException extends Error {
	constructor(type: 'elasticsearch' | 'mongodb') {
		super(`No ${type} connection options provided`);
	}
}
