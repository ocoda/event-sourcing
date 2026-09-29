import type { EventEnvelopeMetadata, IEvent, IEventPayload } from '../interfaces/index.js';
import { EventId } from './event-id.js';

const bigintAsString = (_key: string, value: unknown): unknown =>
	typeof value === 'bigint' ? value.toString() : value;

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
	 * plain object with the fields of the envelope, except that a bigint, such as the `globalPosition`, becomes a
	 * decimal string instead of making `JSON.stringify` throw.
	 */
	toJSON(): { event: string; payload: Record<string, unknown>; metadata: Record<string, unknown> } {
		return JSON.parse(
			JSON.stringify({ event: this.event, payload: this.payload, metadata: this.metadata }, bigintAsString),
		);
	}
}
