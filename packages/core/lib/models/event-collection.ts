import type { IEventCollection } from '../interfaces/index.js';

export class EventCollection {
	static get(pool?: string): IEventCollection {
		return pool ? `${pool}-events` : 'events';
	}
}
