import { Aggregate } from './models';
import { SnapshotEnvelope } from './models/snapshot-envelope';
import { SnapshotStream } from './models/snapshot-stream';

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
    ...envelopes: SnapshotEnvelope<A>[]
  ): void | Promise<void>;
}
