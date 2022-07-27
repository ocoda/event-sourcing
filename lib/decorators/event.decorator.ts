import { Type } from '@nestjs/common';
import { EventEnvelope } from '../event-envelope';
import { IEvent, IEventSerializer } from '../interfaces';
import { EVENT_METADATA } from './constants';

export interface EventMetadata<BaseEvent extends IEvent = IEvent> {
  name: string;
  serializer: IEventSerializer<BaseEvent>;
}

/**
 * Decorator that indicates the name of an event.
 *
 * @param name the name of the event.
 */
export const Event = <BaseEvent extends IEvent = IEvent>(
  options: EventMetadata<BaseEvent>,
): ClassDecorator => {
  return (target) => {
    Reflect.defineMetadata(EVENT_METADATA, options, target);
  };
};
