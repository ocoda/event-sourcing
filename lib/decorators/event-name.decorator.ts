import 'reflect-metadata';
import { EVENT_NAME_METADATA } from './constants';

/**
 * Decorator indicates the name of an event.
 *
 * @param name name of the event.
 */
export const EventName = (name: string): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(EVENT_NAME_METADATA, name, target);
	};
};
