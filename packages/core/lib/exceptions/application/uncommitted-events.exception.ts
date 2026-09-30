import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/** How the message names the operations of `AggregateRoot` that refuse uncommitted events. */
const OPERATIONS = new Map<string | undefined, string>([
	['loadFromHistory', 'loadFromHistory()'],
	['applyEvent', 'applying an event from the history'],
	['version', 'setting the version'],
]);

/**
 * Thrown when an aggregate that has uncommitted events is loaded from history or given a version, for example when
 * `loadFromHistory()` runs after `applyEvent()` without `markCommitted()` in between. The history would be applied
 * after events that were raised on an older state, and the version of those events would shift.
 *
 * Also thrown by `markCommitted(events)` when `events` are not the first uncommitted events of the aggregate, in order:
 * they can't be the events that `getUncommittedEvents()` returned for the append, or they were already marked as
 * committed.
 *
 * The aggregate is left unchanged.
 */
export class UncommittedEventsException extends EventSourcingError {
	override readonly name = 'UncommittedEventsException';
	readonly code = EventSourcingErrorCode.UncommittedEvents;
	/** The class name of the aggregate. */
	readonly aggregateName?: string;
	/**
	 * What was refused: `'loadFromHistory'`, `'applyEvent'` (an event from history), `'version'` (the setter) or
	 * `'markCommitted'` (events that are not the first uncommitted events).
	 */
	readonly operation?: string;
	/** The number of uncommitted events of the aggregate. */
	readonly uncommittedEvents?: number;

	constructor(
		details: { aggregate: Function | string; operation: string; uncommittedEvents: number },
		options?: ErrorOptions,
	) {
		const aggregateName = nameOf(details?.aggregate);
		const operation = OPERATIONS.get(details?.operation) ?? details?.operation ?? 'this operation';
		const uncommitted = `${aggregateName ?? 'The aggregate'} has ${details?.uncommittedEvents ?? 'some'} uncommitted event(s)`;
		super(
			details?.operation === 'markCommitted'
				? `${uncommitted}, and the events given to markCommitted() are not the first of them: pass the events that getUncommittedEvents() returned, once they are appended.`
				: `${uncommitted}, so ${operation} is not allowed: append them and call markCommitted() first.`,
			options,
		);
		this.aggregateName = aggregateName;
		this.operation = details?.operation;
		this.uncommittedEvents = details?.uncommittedEvents;
	}
}
