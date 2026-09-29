import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when an aggregate applies an event it has no `@EventHandler()` for.
 */
export class MissingEventHandlerException extends EventSourcingError {
	override readonly name = 'MissingEventHandlerException';
	readonly code = EventSourcingErrorCode.MissingEventHandler;
	/** The class name of the aggregate. */
	readonly aggregateName?: string;
	/** The class name of the event. */
	readonly eventName?: string;

	constructor(details: { aggregate: Function | string; event: Function | string }, options?: ErrorOptions) {
		const aggregateName = nameOf(details?.aggregate);
		const eventName = nameOf(details?.event);
		super(
			`Missing event-handler exception for ${eventName ?? 'unknown'} in ${aggregateName ?? 'unknown'} (missing @EventHandler(${eventName ?? ''}) decorator?)`,
			options,
		);
		this.aggregateName = aggregateName;
		this.eventName = eventName;
	}
}
