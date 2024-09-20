import type { EventEnvelopeMetadata, IEvent, IEventPayload } from '../interfaces';
import { UUID } from './uuid';

export class EventEnvelope<E extends IEvent = IEvent> {
	private constructor(
		public readonly event: string,
		readonly payload: IEventPayload<E>,
		readonly metadata: EventEnvelopeMetadata,
	) {}

	static create<E extends IEvent = IEvent>(
		event: string,
		payload: IEventPayload<E>,
		metadata: Omit<EventEnvelopeMetadata, 'eventId' | 'occurredOn'> & {
			eventId?: string;
		},
	): EventEnvelope<E> {
		return new EventEnvelope<E>(event, payload, {
			eventId: metadata.eventId || UUID.generate().value,
			occurredOn: new Date(),
			...metadata,
		});
	}

	static from<E extends IEvent = IEvent>(
		event: string,
		payload: IEventPayload<E>,
		metadata: EventEnvelopeMetadata,
	): EventEnvelope<E> {
		return new EventEnvelope<E>(event, payload, metadata);
	}
}
