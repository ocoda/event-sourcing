import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { InvalidEventStreamNameError } from '../exceptions';
import type { EventMetadata } from '../interfaces';
import { EVENT_METADATA } from './constants';

/**
 * Decorator indicates the name of an event.
 *
 * @param name name of the event.
 */
/**
 * Decorator that provides a name to an event constructor.
 * @description The decorated class must extend the `AggregateRoot` class.
 * @param {string=} name Optional name of the event, defaults to the class name.
 * @returns {ClassDecorator}
 * @example `@Event()` or `@Event('account-opened')`
 */
export const Event = (name?: string): ClassDecorator => {
	return (target: any) => {
		const metadata: EventMetadata = { id: randomUUID(), name: name || target.name };

		if (metadata.name.length > 80) {
			throw InvalidEventStreamNameError.becauseExceedsMaxLength(target.name, 80);
		}

		Reflect.defineMetadata(EVENT_METADATA, metadata, target);
	};
};
