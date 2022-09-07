import { EventMap } from './event-map';
import { IEvent } from './interfaces';
import { Aggregate, Id } from './models';
import { EventEnvelope, EventStream } from './models';

export abstract class EventStore {
	abstract eventMap: EventMap;
	abstract getEvents<A extends Aggregate = Aggregate>(
		eventStream: EventStream<A>,
		fromVersion?: number,
	): IEvent[] | Promise<IEvent[]>;
	abstract getEvent<A extends Aggregate = Aggregate>(
		eventStream: EventStream<A>,
		version: number,
	): IEvent | Promise<IEvent>;
	abstract appendEvents<A extends Aggregate = Aggregate>(
		aggregateId: Id,
		aggregateVersion: number,
		eventStream: EventStream<A>,
		events: IEvent[],
	): void | Promise<void>;
	abstract getEnvelopes?<A extends Aggregate = Aggregate>(
		eventStream: EventStream<A>,
		fromVersion?: number,
	): EventEnvelope[] | Promise<EventEnvelope[]>;
	abstract getEnvelope?<A extends Aggregate = Aggregate>(
		eventStream: EventStream<A>,
		version: number,
	): EventEnvelope | Promise<EventEnvelope>;
}
