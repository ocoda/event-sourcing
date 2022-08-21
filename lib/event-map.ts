import { Injectable, Type } from '@nestjs/common';
import { EVENT_NAME_METADATA } from './decorators';
import {
  MissingEventMetadataException,
  UnregisteredEventException,
} from './exceptions';
import { IEvent, IEventSerializer } from './interfaces';

export type EventSerializerType = Type<IEventSerializer<IEvent>>;

interface EventHelpers {
  event: Type<IEvent>;
  serializer?: IEventSerializer<IEvent>;
}

@Injectable()
export class EventMap {
  private readonly eventMap: Map<string, EventHelpers> = new Map();

  public register<E extends Type<IEvent>>(
    event: E,
    serializer?: IEventSerializer,
  ): void {
    const name: string = Reflect.getMetadata(EVENT_NAME_METADATA, event);
    if (!name) {
      throw new MissingEventMetadataException(event);
    }

    this.eventMap.set(name, { event, serializer });
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
  ): IEventSerializer<E> {
    if (!this.eventMap.has(eventName)) {
      throw new UnregisteredEventException(eventName);
    }

    return this.eventMap.get(eventName).serializer as IEventSerializer<E>;
  }
}
