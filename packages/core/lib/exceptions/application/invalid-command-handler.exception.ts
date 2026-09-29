import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a provider registered as a command handler has no class or instance.
 */
export class InvalidCommandHandlerException extends EventSourcingError {
	override readonly name = 'InvalidCommandHandlerException';
	readonly code = EventSourcingErrorCode.InvalidCommandHandler;
	/** The class name of the handler, if it has one. */
	readonly handlerName?: string;

	constructor(details: { handler: unknown }, options?: ErrorOptions) {
		const handlerName = nameOf(details?.handler);
		super(
			`Invalid command handler instance provided. Expected an instance of ICommandHandler, but got ${handlerName ?? String(details?.handler)}.`,
			options,
		);
		this.handlerName = handlerName;
	}
}
