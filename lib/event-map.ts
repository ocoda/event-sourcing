import { Injectable, Type } from '@nestjs/common';
import { EVENT_NAME_METADATA } from './decorators';
import {
  MissingEventMetadataException,
  UnregisteredEventException,
} from './exceptions';
import { IEvent, IEventSerializer } from './interfaces';
import { EventEnvelope, Id } from './models';

export type EventSerializerType = Type<IEventSerializer<IEvent>>;

interface EventData {
  name: string;
  cls: Type<IEvent>;
  serializer?: IEventSerializer<IEvent>;
}

@Injectable()
export class EventMap {
  private readonly eventMap: Set<EventData> = new Set();

  public register<E extends Type<IEvent>>(
    cls: E,
    serializer?: IEventSerializer,
  ): void {
    const name: string = Reflect.getMetadata(EVENT_NAME_METADATA, cls);
    if (!name) {
      throw new MissingEventMetadataException(cls);
    }

    this.eventMap.add({ name, cls, serializer });
  }

  private get<E extends Type<IEvent>>(target: string | E): EventData {
    for (const helper of this.eventMap) {
      if (typeof target === 'string' && target === helper.name) {
        return helper;
      }
      if (typeof target === 'function' && target === helper.cls) {
        return helper;
      }
    }
  }

  public has<E extends Type<IEvent>>(event: string | E): boolean {
    return this.get(event) !== undefined;
  }

  public createEnvelopes(
    aggregateId: Id,
    aggregateVersion: number,
    events: IEvent[],
  ): EventEnvelope[] {
    let sequence = aggregateVersion - events.length + 1;
    return events.map((event) => {
      const { name, serializer } = this.get(event.constructor as Type<IEvent>);
      const envelope = EventEnvelope.new(
        aggregateId,
        sequence,
        name,
        serializer?.serialize(event) || event,
      );

      sequence++;

      return envelope;
    });
  }

  public getConstructor<E extends Type<IEvent>>(eventName: string): E {
    const helper = this.get(eventName);
    if (!helper) {
      throw new UnregisteredEventException(eventName);
    }

    return helper.cls as E;
  }

  public getName<E extends Type<IEvent>>(cls: E): string {
    const helper = this.get(cls);
    if (!helper) {
      throw new UnregisteredEventException(cls.name);
    }

    return helper.name;
  }

  public getSerializer<E extends Type<IEvent>>(
    event: string | E,
  ): IEventSerializer<E> {
    const helper = this.get(event);
    if (!helper) {
      throw new UnregisteredEventException(
        typeof event === 'string' ? event : event.name,
      );
    }

    return helper.serializer as IEventSerializer<E>;
  }
}
