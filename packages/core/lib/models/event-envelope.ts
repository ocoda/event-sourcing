import type { EventEnvelopeMetadata, IEvent, IEventPayload } from '../interfaces/index.js';
import { EventId } from './event-id.js';
import { Id } from './id.js';

const bigintAsString = (_key: string, value: unknown): unknown =>
	typeof value === 'bigint' ? value.toString() : value;

/**
 * The metadata, in the same key order, with every id (the `eventId`) replaced by its value. `ValueObject` itself has no
 * `toJSON`, on purpose: the SQL stores write snapshots and the payloads of custom serializers with `JSON.stringify`,
 * so a `toJSON` there would change what they store for a value object (`{ props: { value } }`, as in 3.x).
 */
const withIdValues = (metadata: EventEnvelopeMetadata): Record<string, unknown> =>
	Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, value instanceof Id ? value.value : value]));

export class EventEnvelope<E extends IEvent = IEvent> {
	private constructor(
		public readonly event: string,
		readonly payload: IEventPayload<E>,
		readonly metadata: EventEnvelopeMetadata,
	) {}

	/**
	 * Creates an envelope for a new event. Without an `eventId`, one is generated (also when `eventId` is given as
	 * `undefined`); without an `occurredOn`, it is the time of the event id.
	 */
	static create<E extends IEvent = IEvent>(
		event: string,
		payload: IEventPayload<E>,
		metadata: Omit<EventEnvelopeMetadata, 'eventId' | 'occurredOn'> & {
			eventId?: EventId;
			occurredOn?: Date;
		},
	): EventEnvelope<E> {
		const { eventId: givenEventId, occurredOn: givenOccurredOn, ...rest } = metadata;
		const eventId = givenEventId ?? EventId.generate();
		return new EventEnvelope<E>(event, payload, {
			eventId,
			occurredOn: givenOccurredOn ?? eventId.date,
			...rest,
		});
	}

	static from<E extends IEvent = IEvent>(
		event: string,
		payload: IEventPayload<E>,
		metadata: EventEnvelopeMetadata,
	): EventEnvelope<E> {
		return new EventEnvelope<E>(event, payload, metadata);
	}

	/**
	 * A copy of the envelope with the given global position; the envelope itself is left as it is.
	 * @internal The event store stamps the positions of the envelopes it stored.
	 */
	withGlobalPosition(globalPosition: bigint): EventEnvelope<E> {
		return new EventEnvelope<E>(this.event, this.payload, { ...this.metadata, globalPosition });
	}

	/**
	 * The JSON form of the envelope, which `JSON.stringify(envelope)` writes. It is what `JSON.stringify` writes for a
	 * plain object with the fields of the envelope, except that:
	 * - the `eventId` becomes its value, a string, instead of `{ props: { value } }`;
	 * - a bigint, such as the `globalPosition`, becomes a decimal string instead of making `JSON.stringify` throw.
	 *
	 * A `Date`, such as the `occurredOn`, becomes an ISO 8601 string. The payload is rendered as the SQL stores write it,
	 * so a value object that a serializer left in it stays `{ props: { value } }`.
	 *
	 * It builds that object with a `JSON.stringify` and `JSON.parse` round trip (so the result is exactly what
	 * `JSON.stringify` makes of every nested value), which means `JSON.stringify(envelope)` serializes the envelope twice.
	 * The stores don't use it; it is meant for logs, APIs and tests, not for hot paths.
	 */
	toJSON(): { event: string; payload: Record<string, unknown>; metadata: Record<string, unknown> } {
		return JSON.parse(
			JSON.stringify(
				{ event: this.event, payload: this.payload, metadata: withIdValues(this.metadata) },
				bigintAsString,
			),
		);
	}
}
