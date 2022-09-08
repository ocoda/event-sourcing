import { randomUUID } from 'crypto';
import { EventEnvelopeMetadata, IEvent, IEventPayload } from '../interfaces';
import { Id } from './id';

export class EventEnvelope<E extends IEvent = IEvent> {
	private constructor(
		public readonly eventId: string,
		public readonly eventName: string,
		readonly payload: IEventPayload<E>,
		readonly metadata: EventEnvelopeMetadata,
	) {}

	static create<E extends IEvent = IEvent>(
		aggregateId: Id,
		sequence: number,
		eventName: string,
		payload: IEventPayload<E>,
	): EventEnvelope<E> {
		return new EventEnvelope<E>(randomUUID(), eventName, payload, {
			aggregateId: aggregateId.value,
			sequence,
			occurredOn: Date.now(),
		});
	}

	static from<E extends IEvent = IEvent>(
		eventId: string,
		eventName: string,
		payload: IEventPayload<E>,
		metadata: EventEnvelopeMetadata,
	): EventEnvelope<E> {
		return new EventEnvelope<E>(eventId, eventName, payload, metadata);
	}
}
