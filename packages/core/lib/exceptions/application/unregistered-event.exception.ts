import type { IEventMapTarget } from '../../event-map.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when an event is stored or read that isn't registered in the `EventSourcingModule`.
 */
export class UnregisteredEventException extends EventSourcingError {
	override readonly name = 'UnregisteredEventException';
	readonly code = EventSourcingErrorCode.UnregisteredEvent;
	/** The event name, or the class name of the event. */
	readonly eventName?: string;

	constructor(details: { event: IEventMapTarget }, options?: ErrorOptions) {
		const eventName = nameOf(details?.event);
		super(`Event '${eventName ?? 'unknown'}' is not registered. Register it in the EventSourcingModule.`, options);
		this.eventName = eventName;
	}
}
