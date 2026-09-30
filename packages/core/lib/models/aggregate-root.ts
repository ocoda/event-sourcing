import type { Type } from '@nestjs/common';
import { MissingEventHandlerException, UncommittedEventsException } from '../exceptions/index.js';
import { getAggregateMetadata, getEventHandlerMetadata } from '../helpers/index.js';
import type { IEvent, IEventHandlerMethod } from '../interfaces/index.js';
import { recordCommittedVersions } from './aggregate-commit-tracker.js';

// Symbol keys keep the bookkeeping out of JSON.stringify() and out of the aggregate's own string keys.
const COMMITTED_VERSION = Symbol('committedVersion');
const EVENTS = Symbol('uncommittedEvents');
const APPLY = Symbol('apply');

/** The event whose handler is running: whether it came from the history, and the events its handler applied. */
interface RunningHandler {
	fromHistory: boolean;
	applied: [event: IEvent, fromHistory: boolean][];
}

// Kept outside the instance, like the commit tracker, so it never shows up on the aggregate or in its snapshots
const runningHandlers = new WeakMap<AggregateRoot, RunningHandler>();

/**
 * The base class of an event-sourced aggregate.
 *
 * An aggregate changes through events: `applyEvent()` runs the event's `@EventHandler()` and records the event as
 * uncommitted. A repository saves it in three steps, so that a failed append loses nothing and can be retried:
 *
 * ```ts
 * const events = account.getUncommittedEvents();
 * await eventStore.appendEvents(stream, events, { expectedVersion: account.committedVersion, pool });
 * account.markCommitted(events);
 * ```
 *
 * `version` is `committedVersion` plus the number of uncommitted events.
 */
export abstract class AggregateRoot {
	private [COMMITTED_VERSION] = 0;
	private readonly [EVENTS]: IEvent[] = [];

	/**
	 * The version of the aggregate: its committed version plus the number of uncommitted events.
	 */
	get version(): number {
		return this[COMMITTED_VERSION] + this[EVENTS].length;
	}

	/**
	 * Sets the committed version, for example when an aggregate is restored from a snapshot.
	 * @throws UncommittedEventsException when the aggregate has uncommitted events
	 */
	set version(version: number) {
		this.assertNoUncommittedEvents('version');
		this[COMMITTED_VERSION] = version;
	}

	/**
	 * The version of the last event that was loaded from the history or marked as committed: the version the stream
	 * is expected to have before the uncommitted events are appended.
	 */
	get committedVersion(): number {
		return this[COMMITTED_VERSION];
	}

	/**
	 * A copy of the events that were applied since the aggregate was loaded or last marked as committed, oldest first.
	 * Once they are appended, pass them to `markCommitted()`.
	 */
	getUncommittedEvents(): readonly IEvent[] {
		return [...this[EVENTS]];
	}

	/**
	 * Marks the uncommitted events as committed, once they are appended: `committedVersion` moves up by their number
	 * and the events are cleared. The snapshot repository uses the range of versions this covers to decide whether a
	 * snapshot is due.
	 *
	 * Pass the events that `getUncommittedEvents()` returned and that were appended: only those are marked as
	 * committed, and events applied in the meantime, such as while the append ran, stay uncommitted for the next save.
	 * Without `events`, every uncommitted event is marked as committed.
	 *
	 * @param events the events that were appended: the first uncommitted events, in order and the same objects
	 * @throws UncommittedEventsException when `events` are not the first uncommitted events; the aggregate is left
	 * unchanged
	 */
	markCommitted(events?: readonly IEvent[]): void {
		const uncommitted = this[EVENTS];
		const count = events == null ? uncommitted.length : events.length;
		if (events != null && (count > uncommitted.length || events.some((event, index) => event !== uncommitted[index]))) {
			throw new UncommittedEventsException({
				aggregate: this.constructor,
				operation: 'markCommitted',
				uncommittedEvents: uncommitted.length,
			});
		}

		const fromVersion = this[COMMITTED_VERSION];
		this[COMMITTED_VERSION] += count;
		uncommitted.splice(0, count);

		// Remember which versions were committed, so a snapshot repository can tell whether an interval was crossed
		recordCommittedVersions(this, fromVersion, this[COMMITTED_VERSION]);
	}

	/**
	 * Returns the uncommitted events and marks them as committed.
	 * @deprecated Use `getUncommittedEvents()`, append the events, then call `markCommitted()`: `commit()` clears the
	 * events before they are appended, so they are lost when the append fails. Removed in 5.0.
	 */
	commit(): IEvent[] {
		const events = [...this[EVENTS]];
		this.markCommitted();
		return events;
	}

	/**
	 * Applies an event: runs its `@EventHandler()`, then counts it towards the version. A new event is recorded as
	 * uncommitted; an event from the history (`fromHistory`) is counted as committed.
	 *
	 * The handler runs first, so a handler that throws leaves the version and the uncommitted events unchanged. When
	 * the aggregate has no handler for the event, `applyEvent()` throws a `MissingEventHandlerException`, unless the
	 * aggregate is decorated with `@Aggregate({ missingHandler: 'ignore' })`.
	 *
	 * An event handler may apply events too. They are applied once the handler returns, after its event and in the
	 * order it applied them, each followed by the events that its own handler applied. When that handler throws, the
	 * events it applied are dropped. While an event from the history is applied, the events its handler applies are
	 * ignored, because the history already holds them.
	 *
	 * @throws UncommittedEventsException when an event from the history is applied to an aggregate that has
	 * uncommitted events
	 */
	applyEvent<T extends IEvent = IEvent>(event: T, fromHistory = false): void {
		const running = runningHandlers.get(this);
		if (!running) {
			this[APPLY](event, fromHistory);
		} else if (!running.fromHistory) {
			running.applied.push([event, fromHistory]);
		}
	}

	private [APPLY](event: IEvent, fromHistory: boolean): void {
		if (fromHistory) {
			this.assertNoUncommittedEvents('applyEvent');
		}

		const handler = this.getEventHandler(event.constructor as Type<IEvent>);
		const running: RunningHandler = { fromHistory, applied: [] };
		if (handler) {
			runningHandlers.set(this, running);
			try {
				handler.call(this, event);
			} finally {
				runningHandlers.delete(this);
			}
		}

		if (fromHistory) {
			this[COMMITTED_VERSION]++;
		} else {
			this[EVENTS].push(event);
		}

		for (const [applied, appliedFromHistory] of running.applied) {
			this[APPLY](applied, appliedFromHistory);
		}
	}

	private getEventHandler<T extends IEvent = IEvent>(eventClass: Type<T>): IEventHandlerMethod<IEvent> | undefined {
		const { method } = getEventHandlerMetadata(this, eventClass);

		if (!method) {
			if (getAggregateMetadata(this.constructor as Type<AggregateRoot>).missingHandler === 'ignore') {
				return undefined;
			}
			throw new MissingEventHandlerException({ aggregate: this.constructor, event: eventClass });
		}

		return this[method];
	}

	/**
	 * Applies events from the history, such as the batches of `eventStore.getEvents()` or an array of events. Each
	 * event counts as committed.
	 * @throws UncommittedEventsException, before reading any event, when the aggregate has uncommitted events
	 */
	async loadFromHistory(events: AsyncIterable<IEvent[]> | Iterable<IEvent>): Promise<void> {
		this.assertNoUncommittedEvents('loadFromHistory');

		if (Symbol.asyncIterator in events) {
			for await (const batch of events) {
				for (const event of batch) {
					this.applyEvent(event, true);
				}
			}
			return;
		}

		for (const event of events) {
			this.applyEvent(event, true);
		}
	}

	private assertNoUncommittedEvents(operation: string): void {
		const uncommittedEvents = this[EVENTS].length;
		if (uncommittedEvents > 0) {
			throw new UncommittedEventsException({ aggregate: this.constructor, operation, uncommittedEvents });
		}
	}
}
