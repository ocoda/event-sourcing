import { EventEnvelope } from '../../models';

export interface IEventBus {
	// biome-ignore lint/suspicious/noConfusingVoidType:
	publish(envelope: EventEnvelope): void | Promise<void>;
}
