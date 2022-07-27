import { randomUUID } from 'crypto';
import { Aggregate } from './aggregate';
import { Id } from './id';
import { IEvent } from './interfaces';
import { EventEnvelopeMetadata } from './interfaces';

export class EventEnvelope<T extends IEvent = IEvent> {
  public readonly eventId: string;
  public readonly eventType: string;
  readonly event: T;
  readonly metadata: EventEnvelopeMetadata;

  private constructor(aggregateId: string, sequence: number, event: T) {
    this.eventId = randomUUID();
    this.eventType = event.constructor.name;
    this.event = event;
    this.metadata = { aggregateId, sequence, occurredOn: Date.now() };
  }

  static new<T extends IEvent = IEvent>(
    aggregateId: Id,
    sequence: number,
    event: T,
  ): EventEnvelope<T> {
    return new EventEnvelope<T>(aggregateId.value, sequence, event);
  }
}
