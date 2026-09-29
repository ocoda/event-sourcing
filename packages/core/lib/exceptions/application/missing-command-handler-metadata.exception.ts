import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a class registered as a command handler has no `@CommandHandler()` metadata.
 */
export class MissingCommandHandlerMetadataException extends EventSourcingError {
	override readonly name = 'MissingCommandHandlerMetadataException';
	readonly code = EventSourcingErrorCode.MissingCommandHandlerMetadata;
	/** The class name of the handler. */
	readonly handlerName?: string;

	constructor(details: { handler: Function | string }, options?: ErrorOptions) {
		const handlerName = nameOf(details?.handler);
		super(
			`Missing command-handler metadata exception for ${handlerName ?? 'unknown'} (missing @CommandHandler() decorator?)`,
			options,
		);
		this.handlerName = handlerName;
	}
}
