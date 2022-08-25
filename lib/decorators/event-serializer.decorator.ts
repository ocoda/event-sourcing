import { IEvent } from '../interfaces';
import 'reflect-metadata';
import { EVENT_SERIALIZER_METADATA } from './constants';

/**
 * Decorator that marks a class as an event serializer. An event serializer
 * is responsible for mapping events to plain objects and vice versa.
 *
 * The decorated class must implement the `IEventSerializer` interface.
 *
 * @param event event *type* to be handled by this serializer.
 */
export const EventSerializer = (event: IEvent): ClassDecorator => {
  return (target: object) => {
    Reflect.defineMetadata(EVENT_SERIALIZER_METADATA, event, target);
  };
};
