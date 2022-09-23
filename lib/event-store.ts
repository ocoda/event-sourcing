import { StreamReadingDirection } from './constants';
import { EventMap } from './event-map';
import { IEvent, IEventPool } from './interfaces';
import { EventEnvelope, EventStream } from './models';

export interface EventFilter {
	eventStream?: EventStream;
	fromVersion?: number;
	direction?: StreamReadingDirection;
	offset?: number;
	limit?: number;
}

export abstract class EventStore {
	abstract eventMap: EventMap;
	abstract setup(pool?: IEventPool): void | Promise<void>;
	abstract getEvents(filter?: EventFilter): AsyncGenerator<IEvent[]>;
	abstract getEvent(eventStream: EventStream, version: number): IEvent | Promise<IEvent>;
	abstract appendEvents(eventStream: EventStream, version: number, events: IEvent[]): void | Promise<void>;
	abstract getEnvelopes?(filter?: EventFilter): AsyncGenerator<EventEnvelope[]>;
	abstract getEnvelope?(eventStream: EventStream, version: number): EventEnvelope | Promise<EventEnvelope>;
}
