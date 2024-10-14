import type { EventEnvelopeMetadata, IEvent, IEventPayload } from '@ocoda/event-sourcing';
import type { Document } from 'mongodb';

export type MongoDBEventEntity = {
	_id: string; // the eventId
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
} & Document &
	Omit<EventEnvelopeMetadata, 'eventId'>;
