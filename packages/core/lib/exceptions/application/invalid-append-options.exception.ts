import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { describeValue } from '../internal.js';

/**
 * Thrown when an append option is invalid, such as a negative or fractional expected version, or an empty pool name.
 * Nothing was written.
 */
export class InvalidAppendOptionsException extends EventSourcingError {
	override readonly name = 'InvalidAppendOptionsException';
	readonly code = EventSourcingErrorCode.InvalidAppendOptions;
	/** The option, such as `'expectedVersion'` or `'pool'`. */
	readonly option: string;
	/** The value that was passed. */
	readonly value: unknown;
	/** What the option has to be. */
	readonly reason: string;

	constructor(details: { option: string; value: unknown; reason: string }, options?: ErrorOptions) {
		super(
			`Invalid append option ${details?.option ?? 'unknown'}: ${details?.reason ?? 'invalid value'}, got ${describeValue(details?.value)}.`,
			options,
		);
		this.option = details?.option;
		this.value = details?.value;
		this.reason = details?.reason;
	}
}
