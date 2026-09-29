import type { EventHeaders, IEvent, IEventPayload } from '@ocoda/event-sourcing';

/**
 * A row of an event table (schema v2), as the store reads it: `global_position` and `occurred_on` as text.
 */
export type MariaDBEventEntity = {
	stream_id: string;
	version: number;
	event: string;
	payload: IEventPayload<IEvent>;
	event_id: string;
	aggregate_id: string;
	/** UTC wall time, `YYYY-MM-DD HH:MM:SS.mmm`. */
	occurred_on: string;
	correlation_id: string | null;
	causation_id: string | null;
	/** A decimal integer. */
	global_position: string;
	headers: EventHeaders | null;
	event_version: number | null;
};
