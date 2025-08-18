import type { Type } from '@nestjs/common';
import type { IEvent } from '../interfaces';

export class EventRegistry {
	private static readonly events: Type<IEvent>[] = [];

	public static register(...event: Type<IEvent>[]): void {
		// add events to the registry
		EventRegistry.events.push(...event);
	}
	public static getEvents(): Type<IEvent>[] {
		// return the registered events
		return EventRegistry.events;
	}
}
