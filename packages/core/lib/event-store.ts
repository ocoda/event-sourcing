import { Logger } from '@nestjs/common';
import { EventMap } from './event-map.js';
import type {
	EventSourcingModuleOptions,
	EventStoreDriver,
	IAllEventsFilter,
	IEvent,
	IEventCollection,
	IEventCollectionFilter,
	IEventFilter,
	IEventPool,
} from './interfaces/index.js';
import type { EventEnvelope, EventStream } from './models/index.js';

/**
 * Event stores that already logged that events were appended before a publish function was set,
 * used to only log that warning once per store.
 */
const storesWithoutPublisherWarned = new WeakSet<object>();

export abstract class EventStore<
	TOptions = Omit<EventSourcingModuleOptions['eventStore'], 'driver'>,
> implements EventStoreDriver {
	protected readonly logger = new Logger(this.constructor.name);
	protected _publish: (envelope: EventEnvelope<IEvent>) => any;

	constructor(
		protected readonly eventMap: EventMap,
		protected readonly options: TOptions,
	) {
		return new Proxy(this, {
			get(target, propKey) {
				if (propKey === 'appendEvents') {
					return async function (...args: unknown[]) {
						const envelopes: EventEnvelope[] = await target[propKey].apply(this, args);

						// The events are persisted at this point, publishing must never make the append fail.
						const publish = target._publish;
						if (typeof publish !== 'function') {
							if (!storesWithoutPublisherWarned.has(target)) {
								storesWithoutPublisherWarned.add(target);
								target.logger.warn(
									'Events were appended before a publish function was set on the event store (is the application bootstrapped?). They were persisted but not published.',
								);
							}
							return envelopes;
						}

						for (const envelope of envelopes) {
							try {
								await publish.call(this, envelope);
							} catch (error) {
								target.logger.error(
									`Failed to publish event "${envelope?.event}" after it was appended`,
									error instanceof Error ? error.stack || error.message : String(error),
								);
							}
						}
						return envelopes;
					};
				}
				return target[propKey];
			},
		});
	}

	/**
	 * Set the publish function.
	 * @param fn The publish function.
	 */
	set publish(fn: (envelope: EventEnvelope<IEvent>) => any) {
		this._publish = fn;
	}

	/**
	 * Connect to the event store.
	 */
	public abstract connect(): void | Promise<void>;

	/**
	 * Disconnect from the event store
	 */
	public abstract disconnect(): void | Promise<void>;

	/**
	 * Ensure an event collection exists.
	 * @param pool The event pool to create the collection for.
	 * @returns The event collection.
	 */
	public abstract ensureCollection(pool?: IEventPool): IEventCollection | Promise<IEventCollection>;

	/**
	 * List the event collections.
	 * @returns The event collections.
	 */
	public abstract listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]>;

	/**
	 * Get an event from the event stream.
	 * @param eventStream The event stream.
	 * @param version The event version.
	 * @param pool The event pool.
	 * @returns The event.
	 */
	abstract getEvent(eventStream: EventStream, version: number, pool?: IEventPool): IEvent | Promise<IEvent>;

	/**
	 * Get events from the event stream.
	 * @param eventStream The event stream.
	 * @param filter The event filter.
	 * @returns The events.
	 */
	abstract getEvents(eventStream: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]>;

	/**
	 * Append events to the event stream.
	 * @param eventStream The event stream.
	 * @param version The event version.
	 * @param events The events.
	 * @param pool The event pool.
	 * @returns The event envelopes.
	 */
	abstract appendEvents(
		eventStream: EventStream,
		version: number,
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]>;

	/**
	 * Get envelopes from the event stream.
	 * @param eventStream The event stream.
	 * @param filter The event filter.
	 * @returns The event envelopes.
	 */
	abstract getEnvelopes?(eventStream: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]>;

	/**
	 * Get an envelope from the event stream.
	 * @param eventStream The event stream.
	 * @param version The event version.
	 * @param pool The event pool.
	 * @returns The event envelope.
	 */
	abstract getEnvelope?(
		eventStream: EventStream,
		version: number,
		pool?: IEventPool,
	): EventEnvelope | Promise<EventEnvelope>;

	/**
	 * Get all envelopes from the event store.
	 * @description creates a range of YYYY-MM from since to until and gets all events in that range
	 */
	abstract getAllEnvelopes(filter: IAllEventsFilter): AsyncGenerator<EventEnvelope[]>;

	protected getYearMonthRange(
		sinceDate: { year: number; month: number },
		untilDate?: { year: number; month: number },
	): string[] {
		// Event buckets are based on UTC dates, so the current month has to be determined in UTC as well
		const now = new Date();
		const [untilYear, untilMonth] = untilDate
			? [untilDate.year, untilDate.month]
			: [now.getUTCFullYear(), now.getUTCMonth() + 1];
		const since = Date.UTC(sinceDate.year, sinceDate.month - 1, 1, 0, 0, 0, 0);
		const until = Date.UTC(untilYear, untilMonth, 0, 23, 59, 59, 999);

		const yearMonthArray: string[] = [];
		const currentDate = new Date(since);

		// Continue looping until we pass the 'until' date
		while (currentDate.getTime() <= until) {
			const year = currentDate.getUTCFullYear();
			const month = String(currentDate.getUTCMonth() + 1).padStart(2, '0'); // Convert month to 'MM' format
			yearMonthArray.push(`${year}-${month}`);

			// Move to the next month
			currentDate.setUTCMonth(currentDate.getUTCMonth() + 1);
		}

		return yearMonthArray;
	}
}
