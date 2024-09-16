import { Inject, Logger } from '@nestjs/common';
import { EVENT_SOURCING_OPTIONS, StreamReadingDirection } from './constants';
import { EventSourcingModuleOptions, ISnapshot, ISnapshotPool } from './interfaces';
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

export abstract class SnapshotStore<TOptions = Omit<EventSourcingModuleOptions['snapshotStore'], 'driver'>> {
	protected readonly logger = new Logger(this.constructor.name);

	constructor(protected readonly options: TOptions) {}

	public abstract start(): unknown | Promise<unknown>;
	public abstract stop(): void | Promise<void>;

	abstract getSnapshots<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]>;
	abstract getSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract getLastSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract appendSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): void | Promise<void>;
	abstract getLastEnvelope<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract getEnvelopes?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;
	abstract getEnvelope?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract getLastEnvelopes?<A extends AggregateRoot>(
		aggregateName: string,
		filter?: LatestSnapshotFilter,
		pool?: ISnapshotPool,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;
}
