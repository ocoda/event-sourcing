import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown by `@Aggregate()` when the stream name is too long.
 */
export class InvalidAggregateStreamNameException extends EventSourcingError {
	override readonly name = 'InvalidAggregateStreamNameException';
	readonly code = EventSourcingErrorCode.InvalidAggregateStreamName;
	/** The class name of the aggregate. */
	readonly aggregateName?: string;
	readonly streamName?: string;
	readonly maxLength: number;

	constructor(
		details: { aggregate: Function | string; streamName?: string; maxLength: number },
		options?: ErrorOptions,
	) {
		const aggregateName = nameOf(details?.aggregate);
		super(
			`Stream name for aggregate '${aggregateName ?? 'unknown'}' exceeds the maximum length of ${details?.maxLength} characters.`,
			options,
		);
		this.aggregateName = aggregateName;
		this.streamName = details?.streamName;
		this.maxLength = details?.maxLength;
	}

	/** @deprecated Use `new InvalidAggregateStreamNameException({ aggregate, streamName, maxLength })`. Removed in 5.0. */
	public static becauseExceedsMaxLength(target: string, maxLength: number): InvalidAggregateStreamNameException {
		return new InvalidAggregateStreamNameException({ aggregate: target, maxLength });
	}
}
