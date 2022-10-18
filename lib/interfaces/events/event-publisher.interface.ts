import { IEvent } from './event.interface';

export interface IEventPublisher<EventBase extends IEvent = IEvent> {
	publish<T extends EventBase = EventBase>(event: T, ...params): any;
	publishAll?<T extends EventBase = EventBase>(events: T[], ...params): any;
}
