import { EventMap } from './event-map';
import { IEvent } from './interfaces';
import { Id } from './models';
import { EventEnvelope, EventStream } from './models';

export abstract class EventStore {
	abstract eventMap: EventMap;
	abstract createPool(eventStream: EventStream): void;
	abstract getEvents(eventStream: EventStream, fromVersion?: number): IEvent[] | Promise<IEvent[]>;
	abstract getEvent(eventStream: EventStream, version: number): IEvent | Promise<IEvent>;
	abstract appendEvents(
		aggregateId: Id,
		aggregateVersion: number,
		eventStream: EventStream,
		events: IEvent[],
	): void | Promise<void>;
	abstract getEnvelopes?(eventStream: EventStream, fromVersion?: number): EventEnvelope[] | Promise<EventEnvelope[]>;
	abstract getEnvelope?(eventStream: EventStream, version: number): EventEnvelope | Promise<EventEnvelope>;
}
