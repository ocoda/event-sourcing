import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a class registered as an event publisher has no `@EventPublisher()` metadata.
 */
export class MissingEventPublisherMetadataException extends EventSourcingError {
	override readonly name = 'MissingEventPublisherMetadataException';
	readonly code = EventSourcingErrorCode.MissingEventPublisherMetadata;
	/** The class name of the publisher. */
	readonly publisherName?: string;

	constructor(details: { publisher: Function | string }, options?: ErrorOptions) {
		const publisherName = nameOf(details?.publisher);
		super(
			`Missing event-publisher metadata exception for ${publisherName ?? 'unknown'} (missing @EventPublisher() decorator?)`,
			options,
		);
		this.publisherName = publisherName;
	}
}
