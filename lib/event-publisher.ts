import { Injectable } from '@nestjs/common';
import { IEvent, IEventPublisher } from './interfaces';

@Injectable()
export class EventPublisher implements IEventPublisher {
	publish<T extends IEvent = IEvent>(event: T) {}
	publishAll?<T extends IEvent = IEvent>(events: T[]) {}
}
