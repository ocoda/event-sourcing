import { Type } from '@nestjs/common';
import { IEvent, ISnapshot } from '../interfaces';

const VERSION = Symbol();
const EVENTS = Symbol();

export abstract class AggregateRoot<EventBase extends IEvent = IEvent> {
	private [VERSION]: number = 0;
	private readonly [EVENTS]: EventBase[] = [];

	set version(version: number) {
		this[VERSION] = version;
	}

	get version(): number {
		return this[VERSION];
	}

	applyEvent<T extends EventBase = EventBase>(event: T, fromHistory = false) {
		this[VERSION]++;

		// If we're just hydrating the aggregate with events,
		// don't push the event to the internal event collection to be committed
		if (!fromHistory) {
			this[EVENTS].push(event);
		}

		const handler = this.getEventHandler(event);
		handler && handler.call(this, event);
	}

	private getEventHandler<T extends EventBase = EventBase>(event: T): Type<typeof AggregateRoot> | undefined {
		const handler = `on${this.getEventName(event)}`;
		return this[handler];
	}

	private getEventName(event: EventBase): string {
		const prototype = Object.getPrototypeOf(event);
		return prototype.constructor.name;
	}

	commit(): IEvent[] {
		const events = [...this[EVENTS]];
		this[EVENTS].length = 0;

		return events;
	}

	loadFromHistory(events: EventBase[]) {
		events.forEach((event) => this.applyEvent(event, true));
	}
}
