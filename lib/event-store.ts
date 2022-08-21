import { EventMap } from './event-map';
import { EventEnvelope } from './models/event-envelope';
import { EventStream } from './models/event-stream';
import { SnapshotEnvelope } from './models/snapshot-envelope';

export enum StreamReadingDirection {
  FORWARD,
  BACKWARD,
}

export abstract class EventStore {
  abstract getEvents(
    eventStream: EventStream,
    fromVersion?: number,
  ): AsyncIterable<EventEnvelope> | Promise<AsyncIterable<EventEnvelope>>;
  abstract getEvent(
    eventStream: EventStream,
    version: number,
  ): EventEnvelope | Promise<EventEnvelope>;
  abstract appendEvent(
    eventStream: EventStream,
    event: EventEnvelope,
  ): void | Promise<void>;
  getSnapshot?(
    eventStream: EventStream,
    version: number,
  ): SnapshotEnvelope | Promise<SnapshotEnvelope>;
  appendSnapshot?(
    eventStream: EventStream,
    event: SnapshotEnvelope,
  ): void | Promise<void>;
}
