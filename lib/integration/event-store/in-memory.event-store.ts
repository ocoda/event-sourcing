import { EventStream } from '../../models/event-stream';
import { EventStore, StreamReadingDirection } from '../../event-store';
import { EventEnvelope } from '../../models/event-envelope';

export class InMemoryEventStore extends EventStore {
  private eventCollection: Map<EventStream, EventEnvelope[]> = new Map();

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

  appendEvents(eventStream: EventStream, ...envelopes: EventEnvelope[]): void {
    const existingEnvelopes = this.eventCollection.get(eventStream) || [];
    this.eventCollection.set(eventStream, [...existingEnvelopes, ...envelopes]);
  }
}
