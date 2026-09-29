import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when a component doesn't support an operation, such as a snapshot store that doesn't override
 * `getLastEnvelopesForAggregate`. Replaces the `NotImplementedException` of `@nestjs/common`, an HTTP 501
 * exception, that 3.x threw.
 */
export class UnsupportedOperationException extends EventSourcingError {
	override readonly name = 'UnsupportedOperationException';
	readonly code = EventSourcingErrorCode.UnsupportedOperation;
	/** The operation, such as a method name. */
	readonly operation: string;
	/** What was asked to perform it, such as 'snapshot store'. */
	readonly component?: string;

	constructor(details: { operation: string; component?: string }, options?: ErrorOptions) {
		super(
			`The ${details?.component ?? 'component'} does not support ${details?.operation ?? 'this operation'}.`,
			options,
		);
		this.operation = details?.operation;
		this.component = details?.component;
	}
}
