import { EventEnvelope } from '@ocoda/event-sourcing/models';

export interface IEventPublisher {
	publish(event: EventEnvelope, ...params): any;
}
