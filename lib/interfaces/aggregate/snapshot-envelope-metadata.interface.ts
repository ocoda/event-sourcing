/**
 * `SnapshotEnvelope` metadata
 */
export interface SnapshotEnvelopeMetadata {
	/**
	 * Unique snapshot ID
	 */
	snapshotId: string;
	/**
	 * Aggregate id the message belongs to.
	 */
	aggregateId: string;
	/**
	 * Version of the aggregate.
	 */
	version: number;
	/**
	 * Time at which the snapshot was taken.
	 */
	registeredOn: Date;
}
