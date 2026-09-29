import type { EventEnvelope } from '../../models/index.js';

export interface IEventBus {
	publish(envelope: EventEnvelope): void | Promise<void>;
}
