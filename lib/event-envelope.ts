import { randomUUID } from 'crypto';
import { Aggregate } from './aggregate';
import { EVENT_METADATA } from './decorators';
import { Id } from './id';
import { IEvent } from './interfaces';
import { EventEnvelopeMetadata } from './interfaces';

export class EventEnvelope<T extends IEvent = IEvent> {
  public readonly eventId: string;
  public readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly metadata: EventEnvelopeMetadata;

  private constructor(
    aggregateId: string,
    sequence: number,
    event: T,
    payload: Record<string, unknown>,
  ) {
    const eventMetadata = Reflect.getMetadata(
      EVENT_METADATA,
      event.constructor,
    );
    this.eventId = randomUUID();
    this.eventName = eventMetadata.name;
    this.payload = payload;
    this.metadata = { aggregateId, sequence, occurredOn: Date.now() };
  }

  static new<T extends IEvent = IEvent>(
    aggregateId: Id,
    sequence: number,
    event: T,
    payload: Record<string, unknown>,
  ): EventEnvelope<T> {
    return new EventEnvelope<T>(aggregateId.value, sequence, event, payload);
  }
}
