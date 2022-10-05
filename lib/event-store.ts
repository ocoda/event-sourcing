import { EventEmitter2 } from '@nestjs/event-emitter';
import { StreamReadingDirection } from './constants';
import { EventMap } from './event-map';
import { IEvent, IEventPool } from './interfaces';
import { EventCollection, EventEnvelope, EventStream } from './models';

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

export abstract class EventStore {
	abstract eventMap: EventMap;
	abstract eventEmitter: EventEmitter2;

	abstract setup(pool?: IEventPool): EventCollection | Promise<EventCollection>;
	abstract getEvents(eventStream: EventStream, filter?: EventFilter): AsyncGenerator<IEvent[]>;
	abstract getEvent(eventStream: EventStream, version: number, pool?: IEventPool): IEvent | Promise<IEvent>;
	abstract appendEvents(
		eventStream: EventStream,
		version: number,
		events: IEvent[],
		pool?: IEventPool,
	): void | Promise<void>;
	abstract getEnvelopes?(eventStream: EventStream, filter?: EventFilter): AsyncGenerator<EventEnvelope[]>;
	abstract getEnvelope?(
		eventStream: EventStream,
		version: number,
		pool?: IEventPool,
	): EventEnvelope | Promise<EventEnvelope>;

	emit(envelope: EventEnvelope) {
		this.eventEmitter.emit(envelope.event, envelope);
	}
}
