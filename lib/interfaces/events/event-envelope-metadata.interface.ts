/**
 * `EventEnvelope` metadata
 */
export interface EventEnvelopeMetadata {
	/**
	 * Aggregate id the message belongs to.
	 */
	aggregateId: string;
	/**
	 * Version of the aggregate.
	 */
	sequence: number;
	/**
	 * Time at which the event ocurred.
	 */
	occurredOn: number;
}
