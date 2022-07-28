import { Injectable, Type } from '@nestjs/common';
import { EVENT_METADATA } from './decorators';
import { EventEnvelope } from './event-envelope';
import { MissingEventMetadataException } from './exceptions';
import { Id } from './id';
import { IEvent, IEventSerializer, IEventTransformer } from './interfaces';

@Injectable()
export class EventTransformer implements IEventTransformer {
  private serializers: Map<string, IEventSerializer> = new Map();

  constructor(eventMap: [Type<IEvent>, IEventSerializer][]) {
    eventMap.forEach(([cls, serializer]) => {
      const name = EventTransformer.getEventName(cls);
      this.serializers.set(name, serializer);
    });
  }

  wrap(
    aggregateId: Id,
    sequence: number,
    event: IEvent,
  ): EventEnvelope<IEvent> {
    const name = EventTransformer.getEventName(event);
    const payload = this.serializers.get(name).serialize(event);

    return EventEnvelope.new(aggregateId, sequence, event, payload);
  }
  unwrap(envelope: EventEnvelope<IEvent>): IEvent {
    const { eventName, payload } = envelope;
    return this.serializers.get(eventName).deserialize(payload);
  }

  static getEventName(event: IEvent | Type<IEvent>): string {
    const eventType = typeof event === 'object' ? event.constructor : event;
    const name = Reflect.getMetadata(EVENT_METADATA, eventType);

    if (!name) {
      throw new MissingEventMetadataException(eventType);
    }
    return name;
  }
}
