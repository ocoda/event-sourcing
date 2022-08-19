import { EventEnvelope } from '../event-envelope';
import { EventStream } from '../event-stream';
import { IEventStore } from '../interfaces';
import { SnapshotEnvelope } from '../snapshot-envelope';

export enum StreamReadingDirection {
  FORWARD,
  BACKWARD,
}

export class InMemoryIterator {
  constructor(
    private readonly events: EventEnvelope[],
    private readonly fromVersion?: number,
    private readonly readingDirection: StreamReadingDirection = StreamReadingDirection.FORWARD,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<EventEnvelope> {
    let eventStream = this.events;

    if (this.fromVersion) {
      const startEventIndex = eventStream.findIndex(
        ({ metadata }) => metadata.sequence === this.fromVersion,
      );
      eventStream = eventStream.slice(startEventIndex);
    }

    if (this.readingDirection === StreamReadingDirection.BACKWARD) {
      eventStream = eventStream.reverse();
    }

    for (const event of eventStream) {
      yield event;
    }
  }
}

export class DefaultEventStore implements IEventStore {
  private eventCollection: Map<EventStream, EventEnvelope[]> = new Map();
  private snapshotCollection: Map<EventStream, SnapshotEnvelope[]> = new Map();

  getEvents(
    eventStream: EventStream,
    fromVersion?: number,
    direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
  ): AsyncIterable<EventEnvelope> {
    return new InMemoryIterator(
      this.eventCollection.get(eventStream),
      fromVersion,
      direction,
    );
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

  appendEvent(eventStream: EventStream, event: EventEnvelope): void {
    const events = this.eventCollection.get(eventStream) || [];
    this.eventCollection.set(eventStream, [...events, event]);
  }

  appendSnapshot(
    eventStream: EventStream,
    snapshot: SnapshotEnvelope,
  ): void | Promise<void> {
    const snapshots = this.snapshotCollection.get(eventStream) || [];
    this.snapshotCollection.set(eventStream, [...snapshots, snapshot]);
  }
}
