import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { EVENT_PUBLISHER_METADATA } from './constants';

/**
 * Decorator that marks a class as an event publisher. An event publisher is responsible for pushing events to topics, queues, etc.
 * @description The decorated class must implement the `IEventPublisher` interface.
 * @returns {ClassDecorator}
 * @example `@EventPublisher()`
 */
export const EventPublisher = (): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_PUBLISHER_METADATA, { id: randomUUID() }, target);
	};
};
