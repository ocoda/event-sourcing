import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import type { IEvent } from '../interfaces/index.js';
import { EVENT_SUBSCRIBER_METADATA } from './constants.js';

/**
 * Decorator that marks a class as an event subscriber. An event-subscriber handles events that took place in your application.
 * @description The decorated class must implement the `IEventSubscriber` interface.
 * @param events One or more event classes whose envelopes will be passed to the subscriber.
 * @returns {ClassDecorator}
 * @example `@EventSubscriber(AccountOpenedEvent, MoneyDepositedEvent)`
 */
export const EventSubscriber = (...events: Type<IEvent>[]): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_SUBSCRIBER_METADATA, { events }, target);
	};
};
