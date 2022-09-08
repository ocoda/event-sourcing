export class UnregisteredSerializerException extends Error {
	constructor(event: string) {
		super(`Serializer for '${event}' event is not registered. Register it in the EventSourcingModule.`);
	}
}
