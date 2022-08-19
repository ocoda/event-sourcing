import { EventStream } from '../../event-stream';
import { EventEnvelope } from '../../event-envelope';
import { SnapshotEnvelope } from '../../snapshot-envelope';

export interface IEventStore {
  getEvents(
    eventStream: EventStream,
    fromVersion?: number,
  ): AsyncIterable<EventEnvelope> | Promise<AsyncIterable<EventEnvelope>>;
  getEvent(
    eventStream: EventStream,
    version: number,
  ): EventEnvelope | Promise<EventEnvelope>;
  getSnapshot?(
    eventStream: EventStream,
    version: number,
  ): SnapshotEnvelope | Promise<SnapshotEnvelope>;
  appendEvent(
    eventStream: EventStream,
    event: EventEnvelope,
  ): void | Promise<void>;
  appendSnapshot?(
    eventStream: EventStream,
    event: SnapshotEnvelope,
  ): void | Promise<void>;
}
