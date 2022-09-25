import { StreamReadingDirection } from './constants';
import { EventMap } from './event-map';
import { IEvent, IEventPool } from './interfaces';
import { EventEnvelope, EventStream } from './models';

interface BaseEventFilter {
	/**
	 * The event stream to filter by.
	 * If not provided, all events will be returned.
	 */
	eventStream?: EventStream;
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
	 * @default 50
	 */
	batch?: number;
}

export interface StreamEventFilter extends BaseEventFilter {
	/**
	 * The event stream to filter by.
	 * If not provided, all events will be returned.
	 */
	eventStream: EventStream;
	/**
	 * The version from where the events should be read.
	 * Can only be used in combination with a stream.
	 * @default 1
	 */
	fromVersion: number;
}

export type EventFilter = BaseEventFilter | StreamEventFilter;

export abstract class EventStore {
	abstract eventMap: EventMap;
	abstract setup(pool?: IEventPool): void | Promise<void>;
	abstract getEvents(filter?: EventFilter): AsyncGenerator<IEvent[]>;
	abstract getEvent(eventStream: EventStream, version: number): IEvent | Promise<IEvent>;
	abstract appendEvents(eventStream: EventStream, version: number, events: IEvent[]): void | Promise<void>;
	abstract getEnvelopes?(filter?: EventFilter): AsyncGenerator<EventEnvelope[]>;
	abstract getEnvelope?(eventStream: EventStream, version: number): EventEnvelope | Promise<EventEnvelope>;
}
