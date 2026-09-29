import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a class registered as an event subscriber has no `@EventSubscriber()` metadata.
 */
export class MissingEventSubscriberMetadataException extends EventSourcingError {
	override readonly name = 'MissingEventSubscriberMetadataException';
	readonly code = EventSourcingErrorCode.MissingEventSubscriberMetadata;
	/** The class name of the subscriber. */
	readonly subscriberName?: string;

	constructor(details: { subscriber: Function | string }, options?: ErrorOptions) {
		const subscriberName = nameOf(details?.subscriber);
		super(
			`Missing event-subscriber metadata exception for ${subscriberName ?? 'unknown'} (missing @EventSubscriber() decorator?)`,
			options,
		);
		this.subscriberName = subscriberName;
	}
}
