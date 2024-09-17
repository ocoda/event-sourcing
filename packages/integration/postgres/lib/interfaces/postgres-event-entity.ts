import { IEvent, IEventPayload } from '@ocoda/event-sourcing';

export type PostgresEventEntity = {
	stream_id: string;
	version: number;
	event: string;
	payload: IEventPayload<IEvent>;
	event_id: string;
	aggregate_id: string;
	occurred_on: Date;
	correlation_id: string | null;
	causation_id: string | null;
};
