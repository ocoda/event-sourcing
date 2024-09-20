import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { InvalidEventStreamNameError } from '../exceptions';
import { EventMetadata } from '../interfaces';
import { EVENT_METADATA } from './constants';

/**
 * Decorator indicates the name of an event.
 *
 * @param name name of the event.
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
