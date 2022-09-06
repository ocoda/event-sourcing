import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IEvent, IEventPublisher } from './interfaces';

@Injectable()
export class EventPublisher implements IEventPublisher {
	constructor(private readonly eventEmitter: EventEmitter2) {}

	publish<T extends IEvent = IEvent>(event: T) {
		this.eventEmitter.emit(event.constructor.name, event);
	}
	publishAll?<T extends IEvent = IEvent>(events: T[]) {
		events.forEach((event) => this.publish(event));
	}
}
