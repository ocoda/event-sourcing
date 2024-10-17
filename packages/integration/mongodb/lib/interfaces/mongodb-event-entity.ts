import type { EventEnvelopeMetadata, IEvent, IEventPayload } from '@ocoda/event-sourcing';
import type { Document } from 'mongodb';

export type MongoDBEventEntity = {
	_id: string; // the eventId
	eventDate: string; // YYYY-MM
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
} & Document &
	Omit<EventEnvelopeMetadata, 'eventId'>;
