import {
	type AggregateRoot,
	DEFAULT_BATCH_SIZE,
	type ILatestSnapshotFilter,
	type ISnapshot,
	type ISnapshotCollection,
	type ISnapshotFilter,
	type ISnapshotPool,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	type SnapshotStream,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { type Db, MongoClient } from 'mongodb';
import type { MongoDBSnapshotEntity, MongoDBSnapshotStoreConfig } from './interfaces';

export class MongoDBSnapshotStore extends SnapshotStore<MongoDBSnapshotStoreConfig> {
	private client: MongoClient;
	private database: Db;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { url, useDefaultPool: _, ...params } = this.options;
		this.client = await new MongoClient(url, params).connect();
		this.database = this.client.db();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		await this.client.close();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);

		try {
			const [existingCollection] = await this.database.listCollections({ name: collection }).toArray();
			if (existingCollection) {
				return collection;
			}

			const snapshotCollection = await this.database.createCollection(collection);
			await snapshotCollection.createIndexes([
				{ key: { streamId: 1, version: 1 }, unique: true },
				{ key: { aggregateName: 1, latest: 1 }, unique: false },
			]);

			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException(collection, error);
		}
	}

	async stop(): Promise<void> {
		this.logger.log('Stopping store');
		await this.client.close();
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

		const entities = [];
		let hasNext: boolean;
		do {
			const entity = await cursor.next();
			hasNext = entity !== null;

			hasNext && entities.push(entity);

			if (entities.length > 0 && (entities.length === batch || !hasNext)) {
				yield entities;
				entities.length = 0;
			}
		} while (hasNext);
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
			const collections = await this.database.listCollections({ name: collection }).toArray();

			if (collections.length === 0) {
				throw new Error(`Collection "${collection}" does not exist.`);
			}

			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});

			const [lastStreamEntity] = await this.getLastStreamEntities<A, ['_id']>(collection, [stream], ['_id']);

			if (lastStreamEntity) {
				await this.database
					.collection<MongoDBSnapshotEntity<A>>(collection)
					.updateOne({ _id: lastStreamEntity._id }, { $set: { latest: null } });
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
			throw new SnapshotStorePersistenceException(collection, error);
		}
	}

	async getLastSnapshot<A extends AggregateRoot>(stream: SnapshotStream, pool?: ISnapshotPool): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.getLastStreamEntities<A, ['payload']>(collection, [stream], ['payload']);

		if (entity) {
			return entity.payload;
		}
	}

	async getManyLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<A, ['streamId', 'payload']>(collection, streams, [
			'streamId',
			'payload',
		]);

		return new Map(
			entities.map(({ streamId, payload }) => [
				streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId),
				payload,
			]),
		);
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
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

		const entities = [];
		let hasNext: boolean;
		do {
			const entity = await cursor.next();
			hasNext = entity !== null;

			hasNext && entities.push(entity);

			if (entities.length > 0 && (entities.length === batch || !hasNext)) {
				yield entities;
				entities.length = 0;
			}
		} while (hasNext);
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

	async *getLastAggregateEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromId = filter?.fromId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<
				Pick<MongoDBSnapshotEntity<A>, 'payload' | 'aggregateId' | 'registeredOn' | 'snapshotId' | 'version'>
			>(collection)
			.find(
				{
					aggregateName,
					...(fromId ? { latest: { $gte: fromId } } : { latest: { $regex: /^latest/ } }),
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

		const entities = [];
		let hasNext: boolean;
		do {
			const entity = await cursor.next();
			hasNext = entity !== null;

			hasNext && entities.push(entity);

			if (entities.length > 0 && (entities.length === batch || !hasNext)) {
				yield entities;
				entities.length = 0;
			}
		} while (hasNext);
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

		return new Map(
			entities.map(({ streamId, payload, aggregateId, registeredOn, snapshotId, version }) => [
				streams.find(({ streamId: currentStreamId }) => currentStreamId === streamId),
				SnapshotEnvelope.from<A>(payload, { aggregateId, registeredOn: new Date(registeredOn), snapshotId, version }),
			]),
		);
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
}
