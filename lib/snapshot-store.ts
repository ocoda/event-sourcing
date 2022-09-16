import { ISnapshot } from './interfaces';
import { AggregateRoot, Id, SnapshotEnvelope, SnapshotStream } from './models';

export abstract class SnapshotStore {
	abstract createPool(pool?: string): void;
	abstract getSnapshots<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		fromVersion?: number,
	): ISnapshot<A>[] | Promise<ISnapshot<A>[]>;
	abstract getSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract getLastSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract appendSnapshot<A extends AggregateRoot>(
		aggregateId: Id,
		aggregateVersion: number,
		snapshotStream: SnapshotStream,
		snapshot: ISnapshot<A>,
	): void | Promise<void>;
	abstract getEnvelopes?<A extends AggregateRoot>(
		eventStream: SnapshotStream,
		fromVersion?: number,
	): SnapshotEnvelope<A>[] | Promise<SnapshotEnvelope<A>[]>;
	abstract getEnvelope?<A extends AggregateRoot>(
		eventStream: SnapshotStream,
		version: number,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
}
