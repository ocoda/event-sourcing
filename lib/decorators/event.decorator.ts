import 'reflect-metadata';
import { EVENT_METADATA } from './constants';

/**
 * Decorator indicates the name of an event.
 *
 * @param name name of the event.
 */
export const Event = (name?: string): ClassDecorator => {
	return (target: any) => {
		Reflect.defineMetadata(EVENT_METADATA, name || target.name, target);
	};
};
