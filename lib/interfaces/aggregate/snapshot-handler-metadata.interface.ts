import { Type } from '@nestjs/common';
import { Aggregate } from '../../models';

/**
 * `@Snapshot` decorator metadata
 */
export interface SnapshotMetadata {
  /**
   * The aggregate type of the snapshot.
   */
  aggregate: Type<Aggregate>;
  /**
   * The name of the aggregate.
   */
  name: string;
  /**
   * Per how many events a snapshot should be taken.
   */
  interval?: number;
}
