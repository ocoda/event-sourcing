import { SetMetadata, Type } from '@nestjs/common';
import { OnEventOptions } from '@nestjs/event-emitter/dist/interfaces';
import { EventListenerMetadata, IEvent } from '../interfaces';
import { EVENT_LISTENER_METADATA } from './constants';

/**
 * Decorator that marks a method as an event listener. An event listener
 * handles events executed by your application code.
 *
 * @param event an event *type* to be handled by this method.
 */
export const EventListener = (event: Type<IEvent>, options?: OnEventOptions): MethodDecorator => {
	return SetMetadata(EVENT_LISTENER_METADATA, {
		event: event.name,
		options,
	} as EventListenerMetadata);
};
