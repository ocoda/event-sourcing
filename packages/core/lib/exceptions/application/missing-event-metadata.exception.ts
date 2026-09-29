import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a class used as an event has no `@Event()` metadata.
 */
export class MissingEventMetadataException extends EventSourcingError {
	override readonly name = 'MissingEventMetadataException';
	readonly code = EventSourcingErrorCode.MissingEventMetadata;
	/** The class name of the event. */
	readonly eventName?: string;

	constructor(details: { event: Function | string }, options?: ErrorOptions) {
		const eventName = nameOf(details?.event);
		super(`Missing event metadata exception for ${eventName ?? 'unknown'} (missing @Event() decorator?)`, options);
		this.eventName = eventName;
	}
}
