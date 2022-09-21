import { EventMap } from './event-map';
import { IEvent, IEventPool } from './interfaces';
import { EventEnvelope, EventStream } from './models';

export abstract class EventStore {
	abstract eventMap: EventMap;
	abstract setup(pool?: IEventPool): void | Promise<void>;
	abstract getEvents(eventStream: EventStream, fromVersion?: number): IEvent[] | Promise<IEvent[]>;
	abstract getEvent(eventStream: EventStream, version: number): IEvent | Promise<IEvent>;
	abstract appendEvents(eventStream: EventStream, version: number, events: IEvent[]): void | Promise<void>;
	abstract getEnvelopes?(eventStream: EventStream, fromVersion?: number): EventEnvelope[] | Promise<EventEnvelope[]>;
	abstract getEnvelope?(eventStream: EventStream, version: number): EventEnvelope | Promise<EventEnvelope>;
}
