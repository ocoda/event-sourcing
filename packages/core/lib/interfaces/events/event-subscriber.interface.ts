import type { EventEnvelope } from '../../models';

export interface IEventSubscriber {
	handle(envelope: EventEnvelope): any;
}
