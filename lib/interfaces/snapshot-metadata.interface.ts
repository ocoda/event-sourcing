/**
 * Interface defining the property object that configures the snapshotting behavior of an aggregate.
*/
export interface SnapshotMetadata {
	  /**
	   * The version interval at which a snapshot should be stored
	   */
	  interval: number;
}