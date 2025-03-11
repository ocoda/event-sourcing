import type { Type } from '@nestjs/common';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import {
	SnapshotNotFoundException,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
} from '../../exceptions';
import { getAggregateMetadata } from '../../helpers';
import type {
	ILatestSnapshotFilter,
	ISnapshot,
	ISnapshotCollection,
	ISnapshotCollectionFilter,
	ISnapshotFilter,
	ISnapshotPool,
	SnapshotEnvelopeMetadata,
	SnapshotStoreConfig,
} from '../../interfaces';
import { type AggregateRoot, SnapshotCollection, SnapshotEnvelope, type SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';

export type InMemorySnapshotEntity<A extends AggregateRoot> = {
	streamId: string;
	payload: ISnapshot<A>;
	aggregateName: string;
	latest?: string;
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
		this.collections.clear();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);
		try {
			this.collections.set(collection, []);
			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException(collection, error);
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

	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		try {
			const snapshotCollection = this.collections.get(collection);

			if (!snapshotCollection) {
				throw new Error('Snapshot collection not found');
			}

			const currentVersion =
				snapshotCollection.find(({ latest }) => latest === `latest#${stream.streamId}`)?.version || 0;

			if (aggregateVersion <= currentVersion) {
				throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, currentVersion);
			}

			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});

			for (const entity of snapshotCollection) {
				if (entity.streamId === stream.streamId) {
					entity.latest = undefined;
				}
			}

			snapshotCollection.push({
				streamId: stream.streamId,
				payload: envelope.payload,
				aggregateName: stream.aggregate,
				latest: `latest#${stream.streamId}`,
				...envelope.metadata,
			});

			return Promise.resolve(envelope);
		} catch (error) {
			switch (error.constructor) {
				case SnapshotStoreVersionConflictException:
					throw error;
				default:
					throw new SnapshotStorePersistenceException(collection, error);
			}
		}
	}

	getLastSnapshot<A extends AggregateRoot>(stream: SnapshotStream, pool?: ISnapshotPool): ISnapshot<A> | void {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const [entity] = this.getLastStreamEntities<A>(snapshotCollection, [stream]);

		if (entity) {
			return entity.payload;
		}
	}

	getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Map<SnapshotStream, ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entities = this.getLastStreamEntities<A>(snapshotCollection, streams);

		return entities.reduce((acc, { streamId, payload }) => {
			const stream = streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId);

			if (stream) {
				acc.set(stream, payload);
			}

			return acc;
		}, new Map<SnapshotStream, ISnapshot<A>>());
	}

	getLastEnvelope<A extends AggregateRoot>(stream: SnapshotStream, pool?: ISnapshotPool): SnapshotEnvelope<A> | void {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const [entity] = this.getLastStreamEntities<A>(snapshotCollection, [stream]);

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

		entities = (this.collections.get(collection) || [])
			.filter(({ aggregateName: name, latest }) => name === aggregateName && latest)
			.sort((envelopeA, envelopeB) => {
				const textA = envelopeA.latest?.toLowerCase() || '';
				const textB = envelopeB.latest?.toLowerCase() || '';
				return textA < textB ? -1 : textA > textB ? 1 : 0;
			})
			.reverse();

		if (aggregateId) {
			entities = (this.collections.get(collection) || []).filter(({ latest }) => (latest || '') > aggregateId);
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

	getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Map<SnapshotStream, SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const snapshotCollection = this.collections.get(collection) || [];

		const entities = this.getLastStreamEntities<A>(snapshotCollection, streams);

		return entities.reduce((acc, { streamId, payload, aggregateId, registeredOn, snapshotId, version }) => {
			const stream = streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId);

			if (stream) {
				acc.set(
					stream,
					SnapshotEnvelope.from<A>(payload, {
						aggregateId,
						registeredOn: new Date(registeredOn),
						snapshotId,
						version,
					}),
				);
			}

			return acc;
		}, new Map<SnapshotStream, SnapshotEnvelope<A>>());
	}

	private getLastStreamEntities<A extends AggregateRoot>(
		collection: InMemorySnapshotEntity<any>[],
		streams: SnapshotStream[],
	): InMemorySnapshotEntity<A>[] {
		const latestIds = streams.map(({ streamId }) => `latest#${streamId}`);
		return collection.filter(({ latest }) => latestIds.includes(latest || ''));
	}
}
