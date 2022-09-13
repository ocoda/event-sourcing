import { IEventStream } from '../events';
import { ISnapshotStream } from './snapshot-stream.interface';

/**
 * `@Aggregate` decorator metadata
 */
export interface AggregateMetadata {
	/**
	 * The name of the event stream.
	 */
	eventStream: IEventStream;
	/**
	 * The name of the snapshot stream.
	 */
	snapshotStream: ISnapshotStream;
}
