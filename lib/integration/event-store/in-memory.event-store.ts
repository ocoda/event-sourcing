import { EventStream } from '../../models/event-stream';
import { EventStore, StreamReadingDirection } from '../../event-store';
import { EventEnvelope } from '../../models/event-envelope';
import { SnapshotEnvelope } from '../../models/snapshot-envelope';
import { EventMap } from '@ocoda/event-sourcing/event-map';

export class InMemoryEventStore extends EventStore {
  private eventCollection: Map<EventStream, EventEnvelope[]> = new Map();
  private snapshotCollection: Map<EventStream, SnapshotEnvelope[]> = new Map();

  getEvents(
    eventStream: EventStream,
    fromVersion?: number,
    direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
  ): EventEnvelope[] {
    let events = this.eventCollection.get(eventStream);

    if (fromVersion) {
      const startEventIndex = events.findIndex(
        ({ metadata }) => metadata.sequence === fromVersion,
      );
      events = events.slice(startEventIndex);
    }

    if (direction === StreamReadingDirection.BACKWARD) {
      events = events.reverse();
    }

    return events;
  }

  getEvent(eventStream: EventStream, version: number): EventEnvelope {
    return this.eventCollection
      .get(eventStream)
      .find(({ metadata }) => metadata.sequence === version);
  }

  getSnapshot(eventStream: EventStream, version: number): SnapshotEnvelope {
    return this.snapshotCollection
      .get(eventStream)
      .find(({ metadata }) => metadata.sequence === version);
  }

  appendEvents(eventStream: EventStream, ...envelopes: EventEnvelope[]): void {
    const existingEnvelopes = this.eventCollection.get(eventStream) || [];
    this.eventCollection.set(eventStream, [...existingEnvelopes, ...envelopes]);
  }

  appendSnapshot(
    eventStream: EventStream,
    snapshot: SnapshotEnvelope,
  ): void | Promise<void> {
    const snapshots = this.snapshotCollection.get(eventStream) || [];
    this.snapshotCollection.set(eventStream, [...snapshots, snapshot]);
  }
}
