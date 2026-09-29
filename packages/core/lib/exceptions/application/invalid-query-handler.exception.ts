import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a provider registered as a query handler has no class or instance.
 */
export class InvalidQueryHandlerException extends EventSourcingError {
	override readonly name = 'InvalidQueryHandlerException';
	readonly code = EventSourcingErrorCode.InvalidQueryHandler;
	/** The class name of the handler, if it has one. */
	readonly handlerName?: string;

	constructor(details: { handler: unknown }, options?: ErrorOptions) {
		const handlerName = nameOf(details?.handler);
		super(
			`Invalid query handler instance provided. Expected an instance of IQueryHandler, but got ${handlerName ?? String(details?.handler)}.`,
			options,
		);
		this.handlerName = handlerName;
	}
}
