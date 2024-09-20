import type { EventEnvelopeMetadata, IEvent, IEventPayload } from '@ocoda/event-sourcing';
import type { Document } from 'mongodb';

export type MongoEventEntity = {
	_id: string;
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
} & Document &
	EventEnvelopeMetadata;
