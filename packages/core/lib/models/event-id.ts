import { monotonicFactory, ulid } from 'ulidx';
import { InvalidIdException } from '../exceptions/index.js';
import { ULID } from './ulid.js';

/**
 * Represents an event identifier.
 * @description An event identifier is a unique identifier for an event, which also contains a timestamp.
 */
export class EventId extends ULID {
	public static generate(dateSeed?: Date): ULID {
		const value = ulid(dateSeed?.getTime());
		return new EventId(value);
	}

	public static from(id: string): ULID {
		if (!id) {
			throw new InvalidIdException({ value: id, idType: EventId.name });
		}
		return new EventId(id);
	}

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

	static factory(): (dateSeed?: Date) => EventId {
		const generator = monotonicFactory();
		return (dateSeed?: Date) => new EventId(generator(dateSeed?.getTime()));
	}
}
