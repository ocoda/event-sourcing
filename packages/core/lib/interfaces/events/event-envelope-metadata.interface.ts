import type { EventId } from '../../models/index.js';
import type { EventHeaders } from './append-options.interface.js';

/**
 * `EventEnvelope` metadata
 */
export interface EventEnvelopeMetadata {
	/**
	 * Unique event ID
	 */
	eventId: EventId;
	/**
	 * Aggregate id the message belongs to.
	 */
	aggregateId: string;
	/**
	 * Version of the aggregate.
	 */
	version: number;
	/**
	 * Time at which the event ocurred.
	 */
	occurredOn: Date;
	/**
	 * ID if the initial event
	 */
	correlationId?: string;
	/**
	 * ID of the preceding event that triggered this event
	 */
	causationId?: string;
	/**
	 * Key-value metadata stored with the event. Absent on events stored without headers, and on 3.x events.
	 */
	headers?: EventHeaders;
	/**
	 * The version of the event's schema, for upcasting. Only set when a pre-built envelope carried it.
	 */
	eventVersion?: number;
	/**
	 * The position of the event in its pool, across streams. Set once the event is stored.
	 */
	globalPosition?: bigint;
}
