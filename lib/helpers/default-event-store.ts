import { EventEnvelope } from '../event-envelope';
import { EventStream } from '../event-stream';
import { IEventStore } from '../interfaces';

export class InMemoryIterator {
  constructor(
    private readonly events: EventEnvelope[],
    private readonly fromVersion?: number,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<EventEnvelope> {
    for (const event of this.events) {
      if (!this.fromVersion || event.metadata.sequence >= this.fromVersion)
        yield event;
    }
  }
}

export class DefaultEventStore implements IEventStore {
  private eventCollection: Map<EventStream, EventEnvelope[]> = new Map();

  getEvents(
    eventStream: EventStream,
    fromVersion?: number,
  ): AsyncIterable<EventEnvelope> {
    return new InMemoryIterator(
      this.eventCollection.get(eventStream),
      fromVersion,
    );
  }

  getEvent(eventStream: EventStream, version: number): EventEnvelope {
    return this.eventCollection
      .get(eventStream)
      .find(({ metadata }) => metadata.sequence === version);
  }

  appendEvent(eventStream: EventStream, event: EventEnvelope): void {
    const events = this.eventCollection.get(eventStream) || [];
    this.eventCollection.set(eventStream, [...events, event]);
  }
}
