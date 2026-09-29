import type { EventMap } from '../../event-map.js';
import type { EventEnvelope } from '../../models/index.js';

/**
 * Publishes the envelopes of an append once they are stored.
 */
export interface EnvelopePublisher {
	/**
	 * Publishes the envelopes of one append, in order. Never rejects: a failing publisher is logged.
	 */
	publishAll(envelopes: readonly EventEnvelope[]): Promise<void>;
}

/**
 * What the library hands an event store when it constructs it.
 */
export interface EventStoreContext {
	/**
	 * The registered events and their serializers.
	 */
	readonly eventMap: EventMap;
	/**
	 * Publishes the envelopes of every append.
	 */
	readonly publisher: EnvelopePublisher;
}
