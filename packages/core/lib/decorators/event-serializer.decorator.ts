import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import type { IEvent } from '../interfaces/index.js';
import { EVENT_SERIALIZER_METADATA } from './constants.js';

/**
 * Decorator that marks a class as an event serializer. An event serializer is responsible for mapping events to plain objects and vice versa.
 * @description The decorated class must implement the `IEventSerializer` interface.
 * @param event The event class handled by this serializer.
 * @returns {ClassDecorator}
 * @example `@EventSerializer(AccountOpenedEvent)`
 */
export const EventSerializer = (event: Type<IEvent>): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_SERIALIZER_METADATA, { event }, target);
	};
};
