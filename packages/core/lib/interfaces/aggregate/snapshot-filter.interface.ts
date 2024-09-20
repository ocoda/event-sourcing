import { StreamReadingDirection } from '../../constants';
import { ISnapshotPool } from './snapshot-pool.type';

export interface ISnapshotFilter {
	/**
	 * The snapshot pool to search in.
	 * @default snapshots
	 */
	pool?: ISnapshotPool;
	/**
	 * The position from where the snapshots should be read.
	 */
	fromVersion?: number;
	/**
	 * The direction in which snapshots should be read.
	 * @default StreamReadingDirection.FORWARD
	 */
	direction?: StreamReadingDirection;
	/**
	 * The number of snapshots to read
	 * @default Number.MAX_SAFE_INTEGER
	 */
	limit?: number;
	/**
	 * The amount of snapshots to read at a time
	 * @default 100
	 */
	batch?: number;
}
