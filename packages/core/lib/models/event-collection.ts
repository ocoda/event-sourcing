import { IEventCollection } from '../interfaces';

export class EventCollection {
	static get(pool?: string): IEventCollection {
		return pool ? `${pool}-events` : 'events';
	}
}
