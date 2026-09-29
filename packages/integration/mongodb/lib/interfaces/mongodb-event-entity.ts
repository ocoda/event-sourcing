import type { EventHeaders, IEvent, IEventPayload } from '@ocoda/event-sourcing';
import type { Long } from 'mongodb';

/**
 * An event document of a 4.0 event collection. Optional fields are absent, never `null`.
 */
export type MongoDBEventEntity = {
	/** The event id. */
	_id: string;
	streamId: string;
	event: string;
	payload: IEventPayload<IEvent>;
	aggregateId: string;
	version: number;
	occurredOn: Date;
	correlationId?: string;
	causationId?: string;
	/** The position of the event in its pool: a 64-bit integer, read as a number, a bigint or a `Long`. */
	globalPosition: Long | number | bigint;
	headers?: EventHeaders;
	eventVersion?: number;
};
