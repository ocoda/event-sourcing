import { EventEnvelope } from '../../event-envelope';
import { EventStream } from '@ocoda/event-sourcing/event-stream';

export interface IEventStore {
  getEvents(
    eventStream: EventStream,
    fromVersion?: number,
  ): AsyncIterable<EventEnvelope> | Promise<AsyncIterable<EventEnvelope>>;
  getEvent(
    eventStream: EventStream,
    version: number,
  ): EventEnvelope | Promise<EventEnvelope>;
  appendEvent(
    eventStream: EventStream,
    event: EventEnvelope,
  ): void | Promise<void>;
}
