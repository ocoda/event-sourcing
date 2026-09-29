import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when an event is registered without a serializer.
 */
export class UnregisteredSerializerException extends EventSourcingError {
	override readonly name = 'UnregisteredSerializerException';
	readonly code = EventSourcingErrorCode.UnregisteredSerializer;
	/** The event name. */
	readonly eventName: string;

	constructor(details: { eventName: string }, options?: ErrorOptions) {
		super(
			`Serializer for '${details?.eventName ?? 'unknown'}' event is not registered. Register it in the EventSourcingModule.`,
			options,
		);
		this.eventName = details?.eventName;
	}
}
