import { StreamReadingDirection } from './constants';
import { ISnapshot, ISnapshotPool } from './interfaces';
import { AggregateRoot, SnapshotEnvelope, SnapshotStream } from './models';

interface BaseSnapshotFilter {
	/**
	 * The snapshot stream to filter by.
	 * If not provided, all snapshots will be returned.
	 */
	snapshotStream?: SnapshotStream;
	/**
	 * The direction in which snapshots should be read.
	 * @default StreamReadingDirection.FORWARD
	 */
	direction?: StreamReadingDirection;
	/**
	 * The number of events to skip
	 */
	skip?: number;
	/**
	 * The number of snapshots to read
	 * @default Number.MAX_SAFE_INTEGER
	 */
	limit?: number;
	/**
	 * The amount of snapshots to read at a time
	 * @default 50
	 */
	batch?: number;
}

export interface StreamSnapshotFilter extends BaseSnapshotFilter {
	/**
	 * The snapshot stream to filter by.
	 * If not provided, all snapshots will be returned.
	 */
	snapshotStream: SnapshotStream;
	/**
	 * The position from where the snapshots should be read.
	 * Can only be used in combination with a stream.
	 * @default 1
	 */
	fromVersion: number;
}

export type SnapshotFilter = BaseSnapshotFilter | StreamSnapshotFilter;

export abstract class SnapshotStore {
	abstract setup(pool?: ISnapshotPool): void | Promise<void>;
	abstract getSnapshots<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<ISnapshot<A>[]>;
	abstract getSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract getLastSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract appendSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
	): void | Promise<void>;
	abstract getLastEnvelope<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract getEnvelopes?<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<SnapshotEnvelope<A>[]>;
	abstract getEnvelope?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
}
