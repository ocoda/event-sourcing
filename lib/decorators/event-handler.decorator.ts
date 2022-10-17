import 'reflect-metadata';
import { IEvent } from '../interfaces';
import { EVENT_HANDLER_METADATA } from './constants';

/**
 * Decorator that marks a class as an event handler. An events handler
 * handles events that took place in your application.
 *
 * The decorated class must implement the `IEventHandler` interface.
 *
 * @param events one or more event *types* to be handled by this handler.
 */
export const EventHandler = (...events: IEvent[]): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_HANDLER_METADATA, { events }, target);
	};
};
