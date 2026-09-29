import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when an aggregate that has uncommitted events is loaded from history or given a version, for example when
 * `loadFromHistory()` runs after `applyEvent()` without `markCommitted()` in between. The history would be applied
 * after events that were raised on an older state, and the version of those events would shift. The aggregate is left
 * unchanged.
 */
export class UncommittedEventsException extends EventSourcingError {
	override readonly name = 'UncommittedEventsException';
	readonly code = EventSourcingErrorCode.UncommittedEvents;
	/** The class name of the aggregate. */
	readonly aggregateName?: string;
	/** What was refused: `'loadFromHistory'`, `'applyEvent'` (an event from history) or `'version'` (the setter). */
	readonly operation?: string;
	/** The number of uncommitted events of the aggregate. */
	readonly uncommittedEvents?: number;

	constructor(
		details: { aggregate: Function | string; operation: string; uncommittedEvents: number },
		options?: ErrorOptions,
	) {
		const aggregateName = nameOf(details?.aggregate);
		super(
			`${aggregateName ?? 'The aggregate'} has ${details?.uncommittedEvents ?? 'some'} uncommitted event(s), so ${details?.operation ?? 'this operation'} is not allowed: append them and call markCommitted() first.`,
			options,
		);
		this.aggregateName = aggregateName;
		this.operation = details?.operation;
		this.uncommittedEvents = details?.uncommittedEvents;
	}
}
