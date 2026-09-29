import type { EventEnvelope } from '../../models/index.js';

export interface IEventSubscriber {
	handle(envelope: EventEnvelope): any;
}
