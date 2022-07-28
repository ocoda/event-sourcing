import { Type } from '@nestjs/common';
import { EventEnvelope } from '../event-envelope';
import { EVENT_METADATA } from './constants';

/**
 * Decorator that indicates the name of an event.
 *
 * @param name the name of the event.
 */
export const EventName = (name: string): ClassDecorator => {
  return (target) => {
    Reflect.defineMetadata(EVENT_METADATA, name, target);
  };
};
