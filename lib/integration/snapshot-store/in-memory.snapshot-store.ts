import { StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';

export interface InMemorySnapshotEntity<A extends AggregateRoot = AggregateRoot> {
	streamId: string;
	payload: ISnapshot<A>;
	metadata: SnapshotEnvelopeMetadata;
}

export class InMemorySnapshotStore extends SnapshotStore {
	private collections: Map<ISnapshotPool, InMemorySnapshotEntity<any>[]> = new Map();

	setup(pool?: ISnapshotPool): void {
		this.collections.set(pool ? `${pool}-snapshots` : 'snapshots', []);
	}

	getSnapshots<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): ISnapshot<A>[] {
		const snapshotCollection = this.collections.get(collection) || [];

		let entities = snapshotCollection.filter(({ streamId: entityStreamId }) => entityStreamId === streamId).sort(
			({ metadata: current }, { metadata: previous }) => (previous.version < current.version ? 1 : -1),
		);

		if (fromVersion) {
			const startSnapshotIndex = entities.findIndex(({ metadata }) => metadata.version === fromVersion);
			entities = startSnapshotIndex === -1 ? [] : entities.slice(startSnapshotIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		return entities.map(({ payload }) => payload);
	}

	getSnapshot<A extends AggregateRoot>({ collection, streamId }: SnapshotStream, version: number): ISnapshot<A> {
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = snapshotCollection.find(
			({ streamId: snapshotStreamId, metadata }) => snapshotStreamId === streamId && metadata.version === version,
		);

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return entity.payload;
	}

	appendSnapshot<A extends AggregateRoot>(
		{ collection, streamId, aggregateId }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
	): void {
		const snapshotCollection = this.collections.get(collection) || [];

		const envelope = SnapshotEnvelope.create<A>(snapshot, { aggregateId, version: aggregateVersion });

		snapshotCollection.push({
			streamId,
			payload: envelope.payload,
			metadata: envelope.metadata,
		});
	}

	getLastSnapshot<A extends AggregateRoot>({ collection, streamId }: SnapshotStream): ISnapshot<A> {
		const snapshotCollection = this.collections.get(collection) || [];

		let entity = snapshotCollection.filter(({ streamId: entityStreamId }) => entityStreamId === streamId).sort(
			({ metadata: current }, { metadata: previous }) => (previous.version < current.version ? -1 : 1),
		)[0];

		if (entity) {
			return entity.payload;
		}
	}

	getLastEnvelope<A extends AggregateRoot>({ collection, streamId }: SnapshotStream): SnapshotEnvelope<A> {
		const snapshotCollection = this.collections.get(collection) || [];

		let entity = snapshotCollection.filter(({ streamId: entityStreamId }) => entityStreamId === streamId).sort(
			({ metadata: current }, { metadata: previous }) => (previous.version < current.version ? -1 : 1),
		)[0];

		if (entity) {
			return SnapshotEnvelope.from(entity.payload, entity.metadata);
		}
	}

	getEnvelopes<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): SnapshotEnvelope<A>[] {
		const snapshotCollection = this.collections.get(collection) || [];

		let entities = snapshotCollection.filter(({ streamId: entityStreamId }) => entityStreamId === streamId).sort(
			({ metadata: current }, { metadata: previous }) => (previous.version < current.version ? 1 : -1),
		);

		if (fromVersion) {
			const startSnapshotIndex = entities.findIndex(({ metadata }) => metadata.version === fromVersion);
			entities = startSnapshotIndex === -1 ? [] : entities.slice(startSnapshotIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		return entities.map(({ payload, metadata }) => SnapshotEnvelope.from<A>(payload, metadata));
	}

	getEnvelope<A extends AggregateRoot>({ collection, streamId }: SnapshotStream, version: number): SnapshotEnvelope<A> {
		const snapshotCollection = this.collections.get(collection) || [];

		let entity = snapshotCollection.find(
			({ streamId: eventStreamId, metadata }) => eventStreamId === streamId && metadata.version === version,
		);

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return SnapshotEnvelope.from(entity.payload, entity.metadata);
	}
}
