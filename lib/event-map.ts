import { Injectable, Type } from '@nestjs/common';
import { EVENT_NAME_METADATA } from './decorators';
import { EventSerializer } from './event-serializer';
import {
  MissingEventMetadataException,
  UnregisteredEventException,
} from './exceptions';
import { IEvent, IEventSerializer } from './interfaces';

interface EventHelpers {
  event: Type<IEvent>;
  serializer: EventSerializer;
}

@Injectable()
export class EventMap {
  private readonly eventMap: Map<string, EventHelpers> = new Map();

  constructor(private readonly eventSerializer: EventSerializer) {}

  public register<E extends Type<IEvent>>(
    event: E,
    eventSerializer?: IEventSerializer,
  ): void {
    const name: string = Reflect.getMetadata(EVENT_NAME_METADATA, event);
    if (!name) {
      throw new MissingEventMetadataException(event);
    }

    this.eventMap.set(name, {
      event,
      serializer: eventSerializer || this.eventSerializer,
    });
  }

  public has(eventName: string): boolean {
    return this.eventMap.has(eventName);
  }

  public getEvent<E extends Type<IEvent>>(eventName: string): E {
    if (!this.eventMap.has(eventName)) {
      throw new UnregisteredEventException(eventName);
    }

    return this.eventMap.get(eventName).event as E;
  }

  public getSerializer<E extends Type<IEvent>>(
    eventName: string,
  ): EventSerializer<E> {
    if (!this.eventMap.has(eventName)) {
      throw new UnregisteredEventException(eventName);
    }

    return this.eventMap.get(eventName).serializer as EventSerializer<E>;
  }
}
