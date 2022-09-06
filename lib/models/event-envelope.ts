import { randomUUID } from 'crypto';
import { EventEnvelopeMetadata } from '../interfaces';
import { Id } from './id';

export class EventEnvelope {
	private constructor(
		public readonly eventId: string,
		public readonly eventName: string,
		readonly payload: Record<string, any>,
		readonly metadata: EventEnvelopeMetadata,
	) {}

	static new(aggregateId: Id, sequence: number, eventName: string, payload: unknown): EventEnvelope {
		return new EventEnvelope(randomUUID(), eventName, payload, {
			aggregateId: aggregateId.value,
			sequence,
			occurredOn: Date.now(),
		});
	}

	static from(eventId: string, eventName: string, payload: unknown, metadata: EventEnvelopeMetadata): EventEnvelope {
		return new EventEnvelope(eventId, eventName, payload, metadata);
	}
}
