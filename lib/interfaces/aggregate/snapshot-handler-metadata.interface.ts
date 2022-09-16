import { Type } from '@nestjs/common';
import { AggregateRoot } from '../../models';

/**
 * `@Snapshot` decorator metadata
 */
export interface SnapshotMetadata<A extends AggregateRoot> {
	/**
	 * The aggregate type of the snapshot.
	 */
	aggregate: Type<A>;
	/**
	 * The name of the snapshot.
	 */
	name: string;
	/**
	 * Per how many events a snapshot should be taken.
	 */
	interval?: number;
}
