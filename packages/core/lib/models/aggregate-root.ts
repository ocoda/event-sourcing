import type { Type } from '@nestjs/common';
import type { IEvent } from '../interfaces';

const VERSION = Symbol();
const EVENTS = Symbol();

export abstract class AggregateRoot {
	private [VERSION] = 0;
	private readonly [EVENTS]: IEvent[] = [];

	set version(version: number) {
		this[VERSION] = version;
	}

	get version(): number {
		return this[VERSION];
	}

	applyEvent<T extends IEvent = IEvent>(event: T, fromHistory = false) {
		this[VERSION]++;

		// If we're just hydrating the aggregate with events,
		// don't push the event to the internal event collection to be committed
		if (!fromHistory) {
			this[EVENTS].push(event);
		}

		const handler = this.getEventHandler(event);
		handler?.call(this, event);
	}

	private getEventHandler<T extends IEvent = IEvent>(event: T): Type<typeof AggregateRoot> | undefined {
		const handler = `on${this.getEventName(event)}`;
		return this[handler];
	}

	private getEventName(event: IEvent): string {
		const prototype = Object.getPrototypeOf(event);
		return prototype.constructor.name;
	}

	commit(): IEvent[] {
		const events = [...this[EVENTS]];
		this[EVENTS].length = 0;

		return events;
	}

	async loadFromHistory(eventCursor: AsyncGenerator<IEvent[]>) {
		for await (const events of eventCursor) {
			for (const event of events) {
				this.applyEvent(event, true);
			}
		}
	}
}
