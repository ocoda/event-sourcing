import { EventEnvelopeMetadata, IEvent, IEventPayload } from '@ocoda/event-sourcing';
import { Document } from 'mongodb';

export type MongoEventEntity = {
	_id: string;
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
} & Document &
	EventEnvelopeMetadata;
