import { EventEnvelope } from '../../models';

export interface IEventBus {
	publish(envelope: EventEnvelope): void | Promise<void>;
}
