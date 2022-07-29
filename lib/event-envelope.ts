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
    eventName: string,
    payload: Record<string, unknown>,
  ) {
    this.eventId = randomUUID();
    this.eventName = eventName;
    this.payload = payload;
    this.metadata = { aggregateId, sequence, occurredOn: Date.now() };
  }

  static new<T extends IEvent = IEvent>(
    aggregateId: Id,
    sequence: number,
    eventName: string,
    payload: Record<string, unknown>,
  ): EventEnvelope<T> {
    return new EventEnvelope<T>(
      aggregateId.value,
      sequence,
      eventName,
      payload,
    );
  }
}
