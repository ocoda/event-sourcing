import type { EventHeaders, IEvent, IEventPayload } from '@ocoda/event-sourcing';

/**
 * A row of an event table (schema v2), as the store reads it.
 */
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
	/** Read as text (`global_position::text`): a `BIGINT` doesn't always fit a number. */
	global_position: string;
	headers: EventHeaders | null;
	event_version: number | null;
};
