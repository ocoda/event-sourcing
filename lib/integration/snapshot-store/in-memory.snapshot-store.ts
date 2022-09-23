import { StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotFilter, SnapshotStore } from '../../snapshot-store';

export interface InMemorySnapshotEntity<A extends AggregateRoot> {
	streamId: string;
	payload: ISnapshot<A>;
	metadata: SnapshotEnvelopeMetadata;
}

export class InMemorySnapshotStore extends SnapshotStore {
	private collections: Map<ISnapshotPool, InMemorySnapshotEntity<any>[]> = new Map();

	setup(pool?: ISnapshotPool): void {
		this.collections.set(pool ? `${pool}-snapshots` : 'snapshots', []);
	}

	async *getSnapshots<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<ISnapshot<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];
		let limit = filter?.limit || 10;

		if (filter?.snapshotStream) {
			const { collection, streamId } = filter.snapshotStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (filter?.fromVersion) {
			const startEventIndex = entities.findIndex(({ metadata }) => metadata.version === filter.fromVersion);
			entities = startEventIndex === -1 ? [] : entities.slice(startEventIndex);
		}

		if (filter?.direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		for (let i = 0; i < entities.length; i += limit) {
			const batch = entities.slice(i, i + limit);
			yield batch.map(({ payload }) => payload);
		}
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

	async *getEnvelopes<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<SnapshotEnvelope<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];
		let limit = filter?.limit || 10;

		if (filter?.snapshotStream) {
			const { collection, streamId } = filter.snapshotStream;
			entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);
		} else {
			for (const collection of this.collections.values()) {
				entities.push(...collection);
			}
		}

		if (filter?.fromVersion) {
			const startEventIndex = entities.findIndex(({ metadata }) => metadata.version === filter.fromVersion);
			entities = startEventIndex === -1 ? [] : entities.slice(startEventIndex);
		}

		if (filter?.direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		for (let i = 0; i < entities.length; i += limit) {
			const batch = entities.slice(i, i + limit);
			yield batch.map(({ payload, metadata }) => SnapshotEnvelope.from<A>(payload, metadata));
		}
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
