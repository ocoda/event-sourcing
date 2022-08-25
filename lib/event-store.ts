import { EventEnvelope } from './models/event-envelope';
import { EventStream } from './models/event-stream';

export enum StreamReadingDirection {
  FORWARD,
  BACKWARD,
}

export abstract class EventStore {
  abstract getEvents(
    eventStream: EventStream,
    fromVersion?: number,
  ): EventEnvelope[] | Promise<EventEnvelope[]>;
  abstract getEvent(
    eventStream: EventStream,
    version: number,
  ): EventEnvelope | Promise<EventEnvelope>;
  abstract appendEvents(
    eventStream: EventStream,
    ...envelopes: EventEnvelope[]
  ): void | Promise<void>;
}
