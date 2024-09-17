import { Logger } from '@nestjs/common';
import { StreamReadingDirection } from './constants';
import { EventMap } from './event-map';
import { EventSourcingModuleOptions, EventStoreDriver, IEvent, IEventPool } from './interfaces';
import { EventEnvelope, EventStream } from './models';

export interface EventFilter {
	/**
	 * The version from where the events should be read.
	 */
	fromVersion?: number;
	/**
	 * The event pool to search in.
	 * @default events
	 */
	pool?: IEventPool;
	/**
	 * The direction in which events should be read.
	 * @default StreamReadingDirection.FORWARD
	 */
	direction?: StreamReadingDirection;
	/**
	 * The number of events to read
	 * @default Number.MAX_SAFE_INTEGER
	 */
	limit?: number;
	/**
	 * The amount of events to read at a time
	 * @default 100
	 */
	batch?: number;
}

export abstract class EventStore<TOptions = Omit<EventSourcingModuleOptions['eventStore'], 'driver'>>
	implements EventStoreDriver<TOptions>
{
	protected readonly logger = new Logger(this.constructor.name);
	protected _publish: (envelope: EventEnvelope<IEvent>) => any;

	constructor(
		protected readonly eventMap: EventMap,
		protected readonly options: TOptions,
	) {
		// biome-ignore lint/correctness/noConstructorReturn:
		return new Proxy(this, {
			get(target, propKey) {
				if (propKey === 'appendEvents') {
					return async function (...args: unknown[]) {
						const envelopes = await target[propKey].apply(this, args);
						for (const envelope of envelopes) {
							await this._publish(envelope);
						}
						return envelopes;
					};
				}
				return target[propKey];
			},
		});
	}

	set publish(fn: (envelope: EventEnvelope<IEvent>) => any) {
		this._publish = fn;
	}

	public abstract start(): unknown | Promise<unknown>;
	public abstract stop(): void | Promise<void>;

	abstract getEvents(eventStream: EventStream, filter?: EventFilter): AsyncGenerator<IEvent[]>;
	abstract getEvent(eventStream: EventStream, version: number, pool?: IEventPool): IEvent | Promise<IEvent>;
	abstract appendEvents(
		eventStream: EventStream,
		version: number,
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]>;
	abstract getEnvelopes?(eventStream: EventStream, filter?: EventFilter): AsyncGenerator<EventEnvelope[]>;
	abstract getEnvelope?(
		eventStream: EventStream,
		version: number,
		pool?: IEventPool,
	): EventEnvelope | Promise<EventEnvelope>;
}
