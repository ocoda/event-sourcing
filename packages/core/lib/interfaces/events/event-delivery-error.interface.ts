import type { EventEnvelope } from '../../models/index.js';

/**
 * A publisher or a subscriber that failed to deliver or handle an envelope, as `EventBus.deliveryErrors$` emits it.
 * The events are stored at that point, so a failure is logged and reported, never thrown.
 */
export interface EventDeliveryError {
	/**
	 * Whether an event publisher or an event subscriber failed.
	 */
	readonly kind: 'publisher' | 'subscriber';
	/**
	 * The class name of the publisher or subscriber.
	 */
	readonly handler: string;
	/**
	 * The envelope it failed to publish or handle. A failing `publishAll` call of a publisher reports each of its
	 * envelopes.
	 */
	readonly envelope: EventEnvelope;
	/**
	 * What it threw or rejected with, or a `DOMException` named `TimeoutError` when a publisher call took longer than
	 * `publishing.publisherTimeout`.
	 */
	readonly error: unknown;
}
