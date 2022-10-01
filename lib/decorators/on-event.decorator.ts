import { Type } from '@nestjs/common';
import 'reflect-metadata';
import { getEventMetadata } from '../helpers';
import { EventListenerMetadata, IEvent } from '../interfaces';
import { EVENT_LISTENER_METADATA } from './constants';

/**
 * Decorator that marks a method as an event listener. An event listener
 * reacts to published events.
 *
 * @param events event *types* to be handled by this method.
 */
export const OnEvent = (event: Type<IEvent>): MethodDecorator => {
	return (target: object, key: string | symbol, descriptor: TypedPropertyDescriptor<any>) => {
		const { name } = getEventMetadata(event);
		Reflect.defineMetadata(EVENT_LISTENER_METADATA, { event: name } as EventListenerMetadata, descriptor.value);
		return descriptor;
	};
};
