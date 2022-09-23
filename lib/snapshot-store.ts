import { StreamReadingDirection } from './constants';
import { ISnapshot, ISnapshotPool } from './interfaces';
import { AggregateRoot, SnapshotEnvelope, SnapshotStream } from './models';

export interface SnapshotFilter {
	snapshotStream?: SnapshotStream;
	fromVersion?: number;
	direction?: StreamReadingDirection;
	offset?: number;
	limit?: number;
}

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
