import { EventEnvelope } from '@ocoda/event-sourcing/models';

export interface IEventPublisher {
	publish(envelope: EventEnvelope, ...params): any;
}
