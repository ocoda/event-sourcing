import 'reflect-metadata';
import { IEvent } from '../interfaces';
import { EVENT_LISTENER_METADATA } from './constants';

/**
 * Decorator that marks a class as an event listener. An event listener
 * reacts to published events.
 *
 * The decorated class must implement the `IEventListener` interface.
 *
 * @param event event *type* to be handled by this serializer.
 */
export const EventListener = (...events: IEvent[]): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_LISTENER_METADATA, events, target);
	};
};
