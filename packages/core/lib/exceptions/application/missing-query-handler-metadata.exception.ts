import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a class registered as a query handler has no `@QueryHandler()` metadata.
 */
export class MissingQueryHandlerMetadataException extends EventSourcingError {
	override readonly name = 'MissingQueryHandlerMetadataException';
	readonly code = EventSourcingErrorCode.MissingQueryHandlerMetadata;
	/** The class name of the handler. */
	readonly handlerName?: string;

	constructor(details: { handler: Function | string }, options?: ErrorOptions) {
		const handlerName = nameOf(details?.handler);
		super(
			`Missing query-handler metadata exception for ${handlerName ?? 'unknown'} (missing @QueryHandler() decorator?)`,
			options,
		);
		this.handlerName = handlerName;
	}
}
