import { Aggregate, SnapshotEnvelope, SnapshotStream } from './models';

export abstract class SnapshotStore {
	abstract getSnapshots<A extends Aggregate>(
		snapshotStream: SnapshotStream<A>,
		fromVersion?: number,
	): SnapshotEnvelope<A>[] | Promise<SnapshotEnvelope<A>[]>;
	abstract getSnapshot<A extends Aggregate>(
		snapshotStream: SnapshotStream<A>,
		version: number,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract getLastSnapshot<A extends Aggregate>(
		snapshotStream: SnapshotStream<A>,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract appendSnapshots<A extends Aggregate>(
		snapshotStream: SnapshotStream<A>,
		envelopes: SnapshotEnvelope<A>[],
	): void | Promise<void>;
}
