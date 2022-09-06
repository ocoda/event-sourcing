export class EventHandlerNotFoundException extends Error {
	constructor(eventName: string) {
		super(`The event handler for the "${eventName}" event was not found`);
	}
}
