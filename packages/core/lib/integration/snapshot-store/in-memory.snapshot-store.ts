import type { Type } from '@nestjs/common';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants.js';
import {
	SnapshotNotFoundException,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
} from '../../exceptions/index.js';
import { getAggregateMetadata } from '../../helpers/index.js';
import type {
	ILatestSnapshotFilter,
	ISnapshot,
	ISnapshotCollection,
	ISnapshotCollectionFilter,
	ISnapshotFilter,
	ISnapshotPool,
	SnapshotEnvelopeMetadata,
	SnapshotStoreConfig,
} from '../../interfaces/index.js';
import { type AggregateRoot, SnapshotCollection, SnapshotEnvelope, type SnapshotStream } from '../../models/index.js';
import { SnapshotStore } from '../../snapshot-store.js';

export type InMemorySnapshotEntity<A extends AggregateRoot> = {
	streamId: string;
	payload: ISnapshot<A>;
	aggregateName: string;
	latest: string | null;
} & SnapshotEnvelopeMetadata;

export interface InMemorySnapshotStoreConfig extends SnapshotStoreConfig {
	driver: Type<InMemorySnapshotStore>;
}

export class InMemorySnapshotStore extends SnapshotStore<InMemorySnapshotStoreConfig> {
	public collections: Map<ISnapshotCollection, InMemorySnapshotEntity<any>[]>;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.collections = new Map();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.collections?.clear();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);
		try {
			// Only create the collection when it doesn't exist yet, never wipe existing snapshots
			if (!this.collections.has(collection)) {
				this.collections.set(collection, []);
			}
			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		let collections: ISnapshotCollection[] = [];

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		collections = [...this.collections.keys()];

		for (let i = 0; i < collections.length; i += batch) {
			const chunk = collections.slice(i, i + batch);
			yield chunk;
		}
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];

		const collection = SnapshotCollection.get(filter?.pool);
		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = (this.collections.get(collection) || []).filter(
			({ streamId: entityStreamId }) => entityStreamId === streamId,
		);

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

	async getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = snapshotCollection.find(
			({ streamId: snapshotStreamId, version: aggregateVersion }) =>
				snapshotStreamId === streamId && aggregateVersion === version,
		);

		if (!entity) {
			throw new SnapshotNotFoundException({ streamId, version, pool });
		}

		return entity.payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		// Everything from the version check to the push runs without awaiting, so concurrent appends to a stream can't
		// interleave: one of them wins, the others conflict, and the stream keeps a single latest snapshot.
		try {
			const snapshotCollection = this.collections.get(collection);

			if (!snapshotCollection) {
				throw new Error('Snapshot collection not found');
			}

			const currentVersion = this.getLastStreamEntity(snapshotCollection, stream)?.version ?? 0;

			if (aggregateVersion <= currentVersion) {
				throw new SnapshotStoreVersionConflictException({
					stream,
					version: aggregateVersion,
					latestVersion: currentVersion,
					pool,
				});
			}

			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});

			for (const entity of snapshotCollection) {
				if (entity.streamId === stream.streamId) {
					entity.latest = null;
				}
			}

			snapshotCollection.push({
				streamId: stream.streamId,
				payload: envelope.payload,
				aggregateName: stream.aggregate,
				latest: `latest#${stream.streamId}`,
				...envelope.metadata,
			});

			return envelope;
		} catch (error) {
			if (error instanceof SnapshotStoreVersionConflictException) {
				throw error;
			}
			throw new SnapshotStorePersistenceException({ collection }, { cause: error });
		}
	}

	async getLastSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A> | void> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		return this.getLastStreamEntity<A>(snapshotCollection, stream)?.payload;
	}

	async getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const snapshots = new Map<SnapshotStream, ISnapshot<A>>();
		for (const stream of streams) {
			const entity = this.getLastStreamEntity<A>(snapshotCollection, stream);
			if (entity) {
				snapshots.set(stream, entity.payload);
			}
		}

		return snapshots;
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = this.getLastStreamEntity<A>(snapshotCollection, stream);

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
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];

		const collection = SnapshotCollection.get(filter?.pool);
		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		entities = (this.collections.get(collection) || []).filter(
			({ streamId: entityStreamId }) => entityStreamId === streamId,
		);

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

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entity = snapshotCollection.find(
			({ streamId: eventStreamId, version: aggregateVersion }) =>
				eventStreamId === streamId && aggregateVersion === version,
		);

		if (!entity) {
			throw new SnapshotNotFoundException({ streamId, version, pool });
		}

		return SnapshotEnvelope.from(entity.payload, {
			aggregateId: entity.aggregateId,
			version: entity.version,
			registeredOn: entity.registeredOn,
			snapshotId: entity.snapshotId,
		});
	}

	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		let entities: InMemorySnapshotEntity<any>[] = [];
		const { streamName: aggregateName } = getAggregateMetadata(aggregate);

		const collection = SnapshotCollection.get(filter?.pool);
		const aggregateId = filter?.aggregateId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		// The latest snapshot of every stream of this aggregate, in descending binary order of their 'latest' key. The
		// keys only differ in the aggregate id, and compare case-sensitively, code unit by code unit.
		entities = (this.collections.get(collection) || [])
			.filter(
				(entity): entity is InMemorySnapshotEntity<any> & { latest: string } =>
					entity.aggregateName === aggregateName && entity.latest !== null,
			)
			.sort(({ latest: keyA }, { latest: keyB }) => (keyA < keyB ? 1 : keyA > keyB ? -1 : 0));

		// The aggregateId is an exclusive cursor: only the streams that come after it in that order are read
		if (aggregateId) {
			const cursor = `latest#${aggregateName}-${aggregateId}`;
			entities = entities.filter(({ latest }) => latest !== null && latest < cursor);
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

	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const envelopes = new Map<SnapshotStream, SnapshotEnvelope<A>>();
		for (const stream of streams) {
			const entity = this.getLastStreamEntity<A>(snapshotCollection, stream);
			if (entity) {
				const { payload, aggregateId, registeredOn, snapshotId, version } = entity;
				envelopes.set(
					stream,
					SnapshotEnvelope.from<A>(payload, { aggregateId, registeredOn: new Date(registeredOn), snapshotId, version }),
				);
			}
		}

		return envelopes;
	}

	/**
	 * The snapshot of the stream with the highest version, whichever snapshot carries the 'latest' key.
	 */
	private getLastStreamEntity<A extends AggregateRoot>(
		collection: InMemorySnapshotEntity<any>[],
		{ streamId }: SnapshotStream,
	): InMemorySnapshotEntity<A> | undefined {
		let last: InMemorySnapshotEntity<A> | undefined;
		for (const entity of collection) {
			if (entity.streamId === streamId && (!last || entity.version > last.version)) {
				last = entity;
			}
		}
		return last;
	}
}
