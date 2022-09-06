/**
 * `SnapshotEnvelope` metadata
 */
export interface SnapshotEnvelopeMetadata {
	/**
   * Aggregate id the message belongs to.
   */
	aggregateId: string;
	/**
   * Version of the aggregate.
   */
	sequence: number;
	/**
   * Time at which the snapshot was taken.
   */
	registeredOn: number;
}
