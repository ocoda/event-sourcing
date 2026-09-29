import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a class registered as an event serializer has no `@EventSerializer()` metadata.
 */
export class MissingEventSerializerMetadataException extends EventSourcingError {
	override readonly name = 'MissingEventSerializerMetadataException';
	readonly code = EventSourcingErrorCode.MissingEventSerializerMetadata;
	/** The class name of the serializer. */
	readonly serializerName?: string;

	constructor(details: { serializer: Function | string }, options?: ErrorOptions) {
		const serializerName = nameOf(details?.serializer);
		super(
			`Missing event-serializer metadata exception for ${serializerName ?? 'unknown'} (missing @EventSerializer() decorator?)`,
			options,
		);
		this.serializerName = serializerName;
	}
}
