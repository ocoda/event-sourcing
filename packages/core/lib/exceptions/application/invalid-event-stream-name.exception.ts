import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown by `@Event()` when the event name is too long.
 */
export class InvalidEventStreamNameException extends EventSourcingError {
	override readonly name = 'InvalidEventStreamNameException';
	readonly code = EventSourcingErrorCode.InvalidEventStreamName;
	/** The class name of the event. */
	readonly eventName?: string;
	readonly maxLength: number;

	constructor(details: { event: Function | string; maxLength: number }, options?: ErrorOptions) {
		const eventName = nameOf(details?.event);
		super(
			`Stream name for event '${eventName ?? 'unknown'}' exceeds the maximum length of ${details?.maxLength} characters.`,
			options,
		);
		this.eventName = eventName;
		this.maxLength = details?.maxLength;
	}

	/** @deprecated Use `new InvalidEventStreamNameException({ event, maxLength })`. Removed in 5.0. */
	public static becauseExceedsMaxLength(target: string, maxLength: number): InvalidEventStreamNameException {
		return new InvalidEventStreamNameException({ event: target, maxLength });
	}
}
