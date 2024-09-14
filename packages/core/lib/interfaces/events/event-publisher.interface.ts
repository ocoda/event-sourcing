import type { EventEnvelope } from '../../models';

export interface IEventPublisher {
	publish(envelope: EventEnvelope, ...params): any;
}
