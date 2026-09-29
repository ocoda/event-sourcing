import type { EventEnvelope } from '../../models/index.js';

/**
 * Sends the envelopes of every append somewhere else, for example to a message broker. Register it with
 * `@EventPublisher()`: the `EventBus` calls it next to its default publisher, which feeds the event subscribers.
 */
export interface IEventPublisher {
	/**
	 * Publishes one envelope. A returned promise is awaited, for at most `publishing.publisherTimeout` milliseconds,
	 * before the publisher gets the next envelope of the append. Any other return value is ignored, so a publisher that
	 * returns the result of its client (a `Promise<RecordMetadata[]>`, an `Observable`) needs no change.
	 */
	publish(envelope: EventEnvelope): unknown;
	/**
	 * Publishes the envelopes of one append, in commit order, in one call. When a publisher implements it, the bus calls
	 * it instead of `publish`. A returned promise is awaited like that of `publish`, and any other return value (the
	 * result of a `sendBatch()`) is ignored.
	 */
	publishAll?(envelopes: readonly EventEnvelope[]): unknown;
}
