import 'reflect-metadata';
import type { IEvent } from '../interfaces';
import { EVENT_HANDLER_METADATA } from './constants';

/**
 * Decorator that marks a class as an event handler. An event-handler handles events that took place in your application.
 * @description The decorated class must implement the `IEventHandler` interface.
 * @param {Array<IEvent>} events One or more event constructors for which the instances need to be handled by this handler.
 * @returns {ClassDecorator}
 * @example `@EventHandler(AccountOpenedEvent, MoneyDepositedEvent)`
 */
export const EventHandler = (...events: IEvent[]): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_HANDLER_METADATA, { events }, target);
	};
};
