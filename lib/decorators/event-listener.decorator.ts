import { SetMetadata, Type } from '@nestjs/common';
import { OnEventOptions } from '@nestjs/event-emitter/dist/interfaces';
import { IEvent } from '../interfaces';
import { EVENT_LISTENER_METADATA } from './constants';

/**
 * `@EventListener` decorator metadata
 */
export interface EventListenerMetadata {
  /**
   * Event type to subscribe to.
   */
  event: IEvent;
  /**
   * Subscription options.
   */
  options?: OnEventOptions;
}

/**
 * Decorator that marks a method as an event listener. An event listener
 * handles events executed by your application code.
 *
 * @param event an event *type* to be handled by this method.
 */
export const EventListener = (
  event: Type<IEvent>,
  options?: OnEventOptions,
): MethodDecorator =>
  SetMetadata(EVENT_LISTENER_METADATA, {
    event: event.name,
    options,
  } as EventListenerMetadata);
