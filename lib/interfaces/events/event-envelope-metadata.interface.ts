/**
 * `EventEnvelope` metadata
 */
export interface EventEnvelopeMetadata {
	/**
	 * Unique event ID
	 */
	eventId: string;
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
}
