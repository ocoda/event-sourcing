import 'reflect-metadata';
import type { IEvent } from '../interfaces';
import { EVENT_SUBSCRIBER_METADATA } from './constants';

/**
 * Decorator that marks a class as an event subscriber. An event-subscriber handles events that took place in your application.
 * @description The decorated class must implement the `IEventSubscriber` interface.
 * @param {Array<IEvent>} events One or more event constructors for which the instances will be passed to the subscriber.
 * @returns {ClassDecorator}
 * @example `@EventSubscriber(AccountOpenedEvent, MoneyDepositedEvent)`
 */
export const EventSubscriber = (...events: IEvent[]): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_SUBSCRIBER_METADATA, { events }, target);
	};
};
