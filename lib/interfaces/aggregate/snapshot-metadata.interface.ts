/**
 * Interface defining the property object that configures the snapshotting behavior of an aggregate.
 */
export interface SnapshotMetadata {
  /**
   * The name of the aggregate for which the snapshot is being taken
   */
  name: string;
  /**
   * The version interval at which a snapshot should be stored
   */
  interval?: number;
}
