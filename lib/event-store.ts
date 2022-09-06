import { Aggregate } from './models';
import { EventEnvelope, EventStream } from './models';

export abstract class EventStore {
	abstract getEvents<A extends Aggregate = Aggregate>(
		eventStream: EventStream<A>,
		fromVersion?: number,
	): EventEnvelope[] | Promise<EventEnvelope[]>;
	abstract getEvent<A extends Aggregate = Aggregate>(
		eventStream: EventStream<A>,
		version: number,
	): EventEnvelope | Promise<EventEnvelope>;
	abstract appendEvents<A extends Aggregate = Aggregate>(
		eventStream: EventStream<A>,
		envelopes: EventEnvelope[],
	): void | Promise<void>;
}
