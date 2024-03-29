import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, EventCollection, SnapshotCollection, SnapshotEnvelope, SnapshotStream } from '../../models';
import { LatestSnapshotFilter, SnapshotFilter, SnapshotStore } from '../../snapshot-store';

export type InMemorySnapshotEntity<A extends AggregateRoot> = {
	streamId: string;
	payload: ISnapshot<A>;
	aggregateName: string;
	latest?: string;
} & SnapshotEnvelopeMetadata;

export class InMemorySnapshotStore extends SnapshotStore {
	public readonly collections: Map<ISnapshotPool, InMemorySnapshotEntity<any>[]> = new Map();

	setup(pool?: ISnapshotPool): EventCollection {
		const collection = SnapshotCollection.get(pool);
		this.collections.set(collection, []);
		return collection;
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];

		const collection = SnapshotCollection.get(filter?.pool);
		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);

		if (fromVersion) {
			entities = entities.filter(({ version }) => version >= fromVersion);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		if (limit) {
			entities = entities.slice(0, limit);
		}

		for (let i = 0; i < entities.length; i += batch) {
			const chunk = entities.slice(i, i + batch);
			yield chunk.map(({ payload }) => payload);
		}
	}

	getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): ISnapshot<A> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = snapshotCollection.find(
			({ streamId: snapshotStreamId, version: aggregateVersion }) =>
				snapshotStreamId === streamId && aggregateVersion === version,
		);

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return entity.payload;
	}

	appendSnapshot<A extends AggregateRoot>(
		{ streamId, aggregateId, aggregate }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): void {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const envelope = SnapshotEnvelope.create<A>(snapshot, { aggregateId, version: aggregateVersion });

		for (const entity of snapshotCollection) {
			if (entity.streamId === streamId) {
				entity.latest = undefined;
			}
		}

		snapshotCollection.push({
			streamId,
			payload: envelope.payload,
			aggregateName: aggregate,
			latest: `latest#${streamId}`,
			...envelope.metadata,
		});
	}

	getLastSnapshot<A extends AggregateRoot>({ streamId }: SnapshotStream, pool?: ISnapshotPool): ISnapshot<A> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = this.getLastStreamEntity<A>(snapshotCollection, streamId);

		if (entity) {
			return entity.payload;
		}
	}

	getLastEnvelope<A extends AggregateRoot>({ streamId }: SnapshotStream, pool?: ISnapshotPool): SnapshotEnvelope<A> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = this.getLastStreamEntity<A>(snapshotCollection, streamId);

		if (entity) {
			return SnapshotEnvelope.from(entity.payload, {
				aggregateId: entity.aggregateId,
				version: entity.version,
				registeredOn: entity.registeredOn,
				snapshotId: entity.snapshotId,
			});
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];

		const collection = SnapshotCollection.get(filter?.pool);
		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = this.collections.get(collection).filter(({ streamId: entityStreamId }) => entityStreamId === streamId);

		if (fromVersion) {
			entities = entities.filter(({ version }) => version >= fromVersion);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		if (limit) {
			entities = entities.slice(0, limit);
		}

		for (let i = 0; i < entities.length; i += batch) {
			const chunk = entities.slice(i, i + batch);
			yield chunk.map(({ payload, aggregateId, registeredOn, snapshotId, version }) =>
				SnapshotEnvelope.from<A>(payload, { aggregateId, registeredOn, snapshotId, version }),
			);
		}
	}

	getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = snapshotCollection.find(
			({ streamId: eventStreamId, version: aggregateVersion }) =>
				eventStreamId === streamId && aggregateVersion === version,
		);

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return SnapshotEnvelope.from(entity.payload, {
			aggregateId: entity.aggregateId,
			version: entity.version,
			registeredOn: entity.registeredOn,
			snapshotId: entity.snapshotId,
		});
	}

	async *getLastEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: LatestSnapshotFilter,
		pool?: ISnapshotPool,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];

		const collection = SnapshotCollection.get(pool);
		const fromId = filter?.fromId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = this.collections
			.get(collection)
			.filter(({ aggregateName: name, latest }) => name === aggregateName && latest)
			.sort((envelopeA, envelopeB) => {
				const textA = envelopeA.latest.toLowerCase();
				const textB = envelopeB.latest.toLowerCase();
				return textA < textB ? -1 : textA > textB ? 1 : 0;
			})
			.reverse();

		if (fromId) {
			entities = this.collections.get(collection).filter(({ latest }) => latest > fromId);
		}

		if (limit) {
			entities = entities.slice(0, limit);
		}

		for (let i = 0; i < entities.length; i += batch) {
			const chunk = entities.slice(i, i + batch);
			yield chunk.map(({ payload, aggregateId, registeredOn, snapshotId, version }) =>
				SnapshotEnvelope.from<A>(payload, { aggregateId, registeredOn, snapshotId, version }),
			);
		}
	}

	private getLastStreamEntity<A extends AggregateRoot>(
		collection: InMemorySnapshotEntity<any>[],
		streamId: string,
	): InMemorySnapshotEntity<A> {
		const [entity] = collection
			.filter(({ streamId: entityStreamId }) => entityStreamId === streamId)
			.sort(({ version: currentVersion }, { version: previousVersion }) => (previousVersion < currentVersion ? -1 : 1));

		if (entity) {
			return entity;
		}
	}
}
