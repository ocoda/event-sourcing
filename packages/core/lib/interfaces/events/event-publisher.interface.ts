import type { EventEnvelope } from '../../models/index.js';

export interface IEventPublisher {
	publish(envelope: EventEnvelope, ...params): any;
}
