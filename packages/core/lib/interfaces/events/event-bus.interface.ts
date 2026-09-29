import type { EventEnvelope } from '../../models/index.js';

export interface IEventBus {
	/**
	 * Publishes one envelope, and resolves once the publishers are done. Never rejects.
	 */
	publish(envelope: EventEnvelope): Promise<void>;
}
