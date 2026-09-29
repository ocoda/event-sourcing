import { ULID } from './ulid.js';

/**
 * Represents an event identifier.
 * @description An event identifier is a unique identifier for an event, which also contains a timestamp.
 * `EventId.generate()`, `EventId.from()` and `EventId.factory()` create `EventId`s.
 */
export class EventId extends ULID {
	/**
	 * Wraps an id that was read from a store, without validating it, so that events stored by an earlier version
	 * (whose ids a stricter `from()` might reject) stay readable.
	 * @internal For the read paths of event stores. Use `from()` for ids from any other source.
	 */
	static fromTrusted(value: string): EventId {
		// Skips the validating constructor, and sets `props` the way ValueObject's (define-semantics) field does.
		const eventId: EventId = Object.create(EventId.prototype);
		Object.defineProperty(eventId, 'props', {
			value: Object.freeze({ value }),
			writable: true,
			enumerable: true,
			configurable: true,
		});
		return eventId;
	}
}
