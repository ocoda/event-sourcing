import { ISnapshot } from './interfaces';
import { Aggregate, Id, SnapshotEnvelope, SnapshotStream } from './models';

export abstract class SnapshotStore {
	abstract getSnapshots<A extends Aggregate>(
		snapshotStream: SnapshotStream<A>,
		fromVersion?: number,
	): ISnapshot<A>[] | Promise<ISnapshot<A>[]>;
	abstract getSnapshot<A extends Aggregate>(
		snapshotStream: SnapshotStream<A>,
		version: number,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract getLastSnapshot<A extends Aggregate>(
		snapshotStream: SnapshotStream<A>,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract appendSnapshot<A extends Aggregate>(
		aggregateId: Id,
		aggregateVersion: number,
		snapshotStream: SnapshotStream<A>,
		snapshot: ISnapshot<A>,
	): void | Promise<void>;
	abstract getEnvelopes?<A extends Aggregate>(
		eventStream: SnapshotStream<A>,
		fromVersion?: number,
	): SnapshotEnvelope<A>[] | Promise<SnapshotEnvelope<A>[]>;
	abstract getEnvelope?<A extends Aggregate>(
		eventStream: SnapshotStream<A>,
		version: number,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
}
