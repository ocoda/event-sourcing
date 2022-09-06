import { SnapshotNotFoundException } from '../../exceptions';
import { StreamReadingDirection } from '../../constants';
import { Aggregate, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';

export class InMemorySnapshotStore extends SnapshotStore {
	private snapshotCollection: Map<string, SnapshotEnvelope<any>[]> = new Map();

	getSnapshots<A extends Aggregate>(
		{ name }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): SnapshotEnvelope<A>[] {
		let snapshots = this.snapshotCollection.get(name) || [];

		if (fromVersion) {
			const startSnapshotIndex = snapshots.findIndex(({ metadata }) => metadata.sequence === fromVersion);
			snapshots = startSnapshotIndex === -1 ? [] : snapshots.slice(startSnapshotIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			snapshots = snapshots.reverse();
		}

		return snapshots;
	}

	getSnapshot<A extends Aggregate>({ name }: SnapshotStream, version: number): SnapshotEnvelope<A> {
		const entity = this.snapshotCollection.get(name)?.find(({ metadata }) => metadata.sequence === version);

		if (!entity) {
			throw SnapshotNotFoundException.withVersion(name, version);
		}

		return entity;
	}

	appendSnapshots<A extends Aggregate>({ name }: SnapshotStream, envelopes: SnapshotEnvelope<A>[]): void {
		const existingEnvelopes = this.snapshotCollection.get(name) || [];
		this.snapshotCollection.set(name, [...existingEnvelopes, ...envelopes]);
	}

	getLastSnapshot<A extends Aggregate>({ name }: SnapshotStream<A>): SnapshotEnvelope<A> {
		const snapshots = this.snapshotCollection.get(name);

		return snapshots?.reduce((previous, current) => {
			return previous.metadata.sequence > current.metadata.sequence ? previous : current;
		}) as SnapshotEnvelope<A>;
	}
}
