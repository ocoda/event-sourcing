import { StreamReadingDirection } from '../../constants';
import { Aggregate, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';

export class InMemorySnapshotStore extends SnapshotStore {
  private snapshotCollection: Map<string, SnapshotEnvelope<any>[]> = new Map();

  getSnapshots<A extends Aggregate>(
    snapshotStream: SnapshotStream,
    fromVersion?: number,
    direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
  ): SnapshotEnvelope<A>[] {
    let snapshots = this.snapshotCollection.get(snapshotStream.name);

    if (fromVersion) {
      const startSnapshotIndex = snapshots.findIndex(
        ({ metadata }) => metadata.sequence === fromVersion,
      );
      snapshots = snapshots.slice(startSnapshotIndex);
    }

    if (direction === StreamReadingDirection.BACKWARD) {
      snapshots = snapshots.reverse();
    }

    return snapshots;
  }

  getSnapshot<A extends Aggregate>(
    snapshotStream: SnapshotStream,
    version: number,
  ): SnapshotEnvelope<A> {
    return this.snapshotCollection
      .get(snapshotStream.name)
      .find(({ metadata }) => metadata.sequence === version);
  }

  appendSnapshots<A extends Aggregate>(
    snapshotStream: SnapshotStream,
    ...envelopes: SnapshotEnvelope<A>[]
  ): void {
    const existingEnvelopes =
      this.snapshotCollection.get(snapshotStream.name) || [];
    this.snapshotCollection.set(snapshotStream.name, [
      ...existingEnvelopes,
      ...envelopes,
    ]);
  }

  getLastSnapshot<A extends Aggregate>(
    snapshotStream: SnapshotStream<A>,
  ): SnapshotEnvelope<A> {
    const snapshots = this.snapshotCollection.get(snapshotStream.name);
    if (!snapshots) {
      return;
    }

    return snapshots.reduce((previous, current) => {
      return previous.metadata.sequence > current.metadata.sequence
        ? previous
        : current;
    }) as SnapshotEnvelope<A>;
  }
}
