import { StreamReadingDirection } from './constants';
import { ISnapshot, ISnapshotPool } from './interfaces';
import { AggregateRoot, SnapshotCollection, SnapshotEnvelope, SnapshotStream } from './models';

export interface SnapshotFilter {
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

export interface LatestSnapshotFilter extends Pick<SnapshotFilter, 'batch' | 'limit'> {
	fromId?: string;
}

export abstract class SnapshotStore {
	abstract setup(pool?: ISnapshotPool): SnapshotCollection | Promise<SnapshotCollection>;
	abstract getSnapshots<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]>;
	// biome-ignore lint/suspicious/noRedeclare:
	abstract getSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	// biome-ignore lint/suspicious/noRedeclare:
	abstract getLastSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	// biome-ignore lint/suspicious/noRedeclare:
	abstract appendSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
		// biome-ignore lint/suspicious/noConfusingVoidType:
	): void | Promise<void>;
	// biome-ignore lint/suspicious/noRedeclare:
	abstract getLastEnvelope<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	// biome-ignore lint/suspicious/noRedeclare:
	abstract getEnvelopes?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;
	// biome-ignore lint/suspicious/noRedeclare:
	abstract getEnvelope?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	// biome-ignore lint/suspicious/noRedeclare:
	abstract getLastEnvelopes?<A extends AggregateRoot>(
		aggregateName: string,
		filter?: LatestSnapshotFilter,
		pool?: ISnapshotPool,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;
}
