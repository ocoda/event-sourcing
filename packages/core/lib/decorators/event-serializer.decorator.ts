import 'reflect-metadata';
import type { IEvent } from '../interfaces';
import { EVENT_SERIALIZER_METADATA } from './constants';

/**
 * Decorator that marks a class as an event serializer. An event serializer is responsible for mapping events to plain objects and vice versa.
 * @description The decorated class must implement the `IEventSerializer` interface.
 * @param {IEvent} event The event constructor to be handled by this serializer.
 * @returns {ClassDecorator}
 * @example `@EventSerializer(AccountOpenedEvent)`
 */
export const EventSerializer = (event: IEvent): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_SERIALIZER_METADATA, { event }, target);
	};
};
