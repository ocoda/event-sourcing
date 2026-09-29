import type { Type } from '@nestjs/common';
import {
	type AggregateRoot,
	DEFAULT_BATCH_SIZE,
	type ILatestSnapshotFilter,
	type ISnapshot,
	type ISnapshotCollection,
	type ISnapshotCollectionFilter,
	type ISnapshotFilter,
	type ISnapshotPool,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	type SnapshotStream,
	StreamReadingDirection,
	getAggregateMetadata,
} from '@ocoda/event-sourcing';
import { type Db, MongoClient } from 'mongodb';
import type { MongoDBSnapshotEntity, MongoDBSnapshotStoreConfig } from './interfaces/index.js';
import { batchCursor, isDuplicateKeyError } from './mongodb.utils.js';

export class MongoDBSnapshotStore extends SnapshotStore<MongoDBSnapshotStoreConfig> {
	private client: MongoClient;
	private database: Db;
	/** Collections that are known to exist, so that appends don't have to look them up on every write. */
	private readonly knownCollections = new Set<string>();

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { url, useDefaultPool: _, ...params } = this.options;
		this.client = await new MongoClient(url, params).connect();
		this.database = this.client.db();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.knownCollections.clear();
		await this.client.close();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);

		try {
			const [existingCollection] = await this.database.listCollections({ name: collection }).toArray();
			if (!existingCollection) {
				const snapshotCollection = await this.database.createCollection(collection);
				await snapshotCollection.createIndexes([
					{ key: { streamId: 1, version: 1 }, unique: true },
					{ key: { aggregateName: 1, latest: 1 }, unique: false },
				]);
			}

			this.knownCollections.add(collection);

			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException(collection, error);
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.listCollections({
				name: { $regex: /snapshots/ },
			})
			.map(({ name }) => name as ISnapshotCollection);

		yield* batchCursor(cursor, batch);
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<Pick<MongoDBSnapshotEntity<A>, 'payload'>>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
					projection: { _id: 0, payload: 1 },
				},
			)
			.map(({ payload }) => payload);

		yield* batchCursor(cursor, batch);
	}

	async getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const entity = await this.database.collection<Pick<MongoDBSnapshotEntity<A>, 'payload'>>(collection).findOne(
			{
				streamId,
				version,
			},
			{ projection: { _id: 0, payload: 1 } },
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
			await this.assertCollectionExists(collection);

			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});

			const [lastStreamEntity] = await this.getLastStreamEntities<A, ['_id', 'version']>(
				collection,
				[stream],
				['_id', 'version'],
			);

			if (aggregateVersion <= lastStreamEntity?.version) {
				throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, lastStreamEntity.version);
			}

			if (lastStreamEntity) {
				await this.database
					.collection<MongoDBSnapshotEntity<A>>(collection)
					.updateOne({ _id: lastStreamEntity._id }, { $set: { latest: undefined } });
			}

			await this.database.collection<MongoDBSnapshotEntity<A>>(collection).insertOne({
				_id: envelope.metadata.snapshotId,
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

			// A concurrent writer stored the same (streamId, version) between our check and our insert.
			if (isDuplicateKeyError(error)) {
				const latestVersion = await this.getLatestVersion(collection, stream);
				throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, latestVersion, error);
			}

			throw new SnapshotStorePersistenceException(collection, error);
		}
	}

	async getLastSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A> | void> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.getLastStreamEntities<A, ['payload']>(collection, [stream], ['payload']);

		if (entity) {
			return entity.payload;
		}
	}

	async getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<A, ['streamId', 'payload']>(collection, streams, [
			'streamId',
			'payload',
		]);

		return entities.reduce((acc, { streamId, payload }) => {
			const stream = streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId);

			if (stream) {
				acc.set(stream, payload);
			}

			return acc;
		}, new Map<SnapshotStream, ISnapshot<A>>());
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.getLastStreamEntities<
			A,
			['payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']
		>(collection, [stream], ['payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']);

		if (entity) {
			return SnapshotEnvelope.from<A>(entity.payload, {
				snapshotId: entity.snapshotId,
				aggregateId: entity.aggregateId,
				registeredOn: entity.registeredOn,
				version: entity.version,
			});
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<
				Pick<MongoDBSnapshotEntity<A>, 'payload' | 'aggregateId' | 'registeredOn' | 'snapshotId' | 'version'>
			>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
					projection: { _id: 0, payload: 1, aggregateId: 1, registeredOn: 1, snapshotId: 1, version: 1 },
				},
			)
			.map(({ payload, aggregateId, registeredOn, snapshotId, version }) =>
				SnapshotEnvelope.from<A>(payload, { aggregateId, registeredOn, snapshotId, version }),
			);

		yield* batchCursor(cursor, batch);
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const entity = await this.database
			.collection<
				Pick<MongoDBSnapshotEntity<A>, 'payload' | 'aggregateId' | 'registeredOn' | 'snapshotId' | 'version'>
			>(collection)
			.findOne(
				{ streamId, version },
				{ projection: { _id: 0, payload: 1, aggregateId: 1, registeredOn: 1, snapshotId: 1, version: 1 } },
			);

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return SnapshotEnvelope.from<A>(entity.payload, {
			aggregateId: entity.aggregateId,
			registeredOn: entity.registeredOn,
			snapshotId: entity.snapshotId,
			version: entity.version,
		});
	}

	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);
		const { streamName } = getAggregateMetadata(aggregate);

		const aggregateId = filter?.aggregateId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<
				Pick<MongoDBSnapshotEntity<A>, 'payload' | 'aggregateId' | 'registeredOn' | 'snapshotId' | 'version'>
			>(collection)
			.find(
				{
					aggregateName: streamName,
					...(aggregateId ? { latest: { $gte: aggregateId } } : { latest: { $regex: /^latest/ } }),
				},
				{
					sort: { latest: -1 },
					limit,
					projection: { _id: 0, payload: 1, aggregateId: 1, registeredOn: 1, snapshotId: 1, version: 1 },
				},
			)
			.map(({ payload, aggregateId, registeredOn, snapshotId, version }) =>
				SnapshotEnvelope.from<A>(payload, { aggregateId, registeredOn, snapshotId, version }),
			);

		yield* batchCursor(cursor, batch);
	}

	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<
			A,
			['streamId', 'payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']
		>(collection, streams, ['streamId', 'payload', 'snapshotId', 'aggregateId', 'registeredOn', 'version']);

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

	private async getLastStreamEntities<
		A extends AggregateRoot,
		Fields extends (keyof MongoDBSnapshotEntity<A>)[] = (keyof MongoDBSnapshotEntity<A>)[],
	>(collection: string, streams: SnapshotStream[], fields: Fields): Promise<MongoDBSnapshotEntity<A>[]> {
		const latestIds = streams.map(({ streamId }) => `latest#${streamId}`);
		return this.database
			.collection<MongoDBSnapshotEntity<A>>(collection)
			.find(
				{ latest: { $in: latestIds } },
				{
					projection: {
						_id: 0,
						...fields.reduce((acc, v) => {
							acc[v] = 1;
							return acc;
						}, {}),
					},
				},
			)
			.toArray();
	}

	/**
	 * Rejects appends to collections that were never created (unknown pools).
	 * Collections that are known to exist are not looked up again, the server is only asked on a cache miss.
	 */
	private async assertCollectionExists(collection: ISnapshotCollection): Promise<void> {
		if (this.knownCollections.has(collection)) {
			return;
		}

		const collections = await this.database.listCollections({ name: collection }).toArray();

		if (collections.length === 0) {
			throw new Error(`Collection "${collection}" does not exist.`);
		}

		this.knownCollections.add(collection);
	}

	/**
	 * Best effort lookup of the latest snapshot version of a stream, used to report a conflict.
	 */
	private async getLatestVersion(collection: ISnapshotCollection, { streamId }: SnapshotStream): Promise<number> {
		try {
			const [latest] = await this.database
				.collection<MongoDBSnapshotEntity<AggregateRoot>>(collection)
				.find({ streamId })
				.sort({ version: -1 })
				.limit(1)
				.project({ version: 1 })
				.toArray();
			return latest?.version ?? 0;
		} catch {
			return 0;
		}
	}
}
