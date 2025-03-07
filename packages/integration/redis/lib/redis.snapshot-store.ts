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
	SnapshotStore,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	type SnapshotStream,
} from '@ocoda/event-sourcing';
import { createClient, type RedisFunctions, type RedisModules, type RedisScripts, type RedisClientType } from 'redis';
import type { RedisSnapshotStoreConfig } from './interfaces';
import { Repository } from 'redis-om';
import { snapshotSchema } from './redis-snapshot-schema';

export class RedisSnapshotStore extends SnapshotStore<RedisSnapshotStoreConfig> {
	private client: RedisClientType<RedisModules, RedisFunctions, RedisScripts>;
	private repository: Repository;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { useDefaultPool: _, driver, ...params } = this.options;
		this.client = createClient({ ...params });
		await this.client.connect();
		this.repository = new Repository(snapshotSchema, this.client);
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		await this.client.quit();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);
		try {
			await this.client.set(collection, JSON.stringify([]));
			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException(collection, error);
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		const keys = await this.client.keys('*snapshots*');
		for (let i = 0; i < keys.length; i += batch) {
			yield keys.slice(i, i + batch) as ISnapshotCollection[];
		}
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		// TODO: Implement
		yield [];
	}

	async getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		// TODO: Implement
		return;
	}

	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		try {
			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});

			const streamKey = `${collection}:${stream.streamId}:${aggregateVersion}`;
			const versionKey = `${collection}:${stream.streamId}:versions`;

			const beforeAppend = await this.client.zRangeWithScores(versionKey, 0, 0);
			console.log({ beforeAppend });
			await this.client.rPush(streamKey, [
				envelope.metadata.version.toString(),
				JSON.stringify(envelope.payload),
				envelope.metadata.snapshotId,
				envelope.metadata.aggregateId,
				envelope.metadata.registeredOn.toISOString(),
				stream.aggregate,
			]);

			// Also, store the aggregate version in the sorted set
			await this.client.zAdd('foo', 1, 'foo');
			// const afterAppend = await this.client.zRange(versionKey, 0, 0);
			// console.log({ afterAppend });
			//   if (highestVersionStreamKey.length > 0) {
			// 	// Now fetch the corresponding element from the list
			// 	const streamKey = highestVersionStreamKey[0];
			// 	console.log('Element with highest version:', element);
			//   }

			// const [lastStreamEntity] = await this.getLastStreamEntities<A, ['_id', 'version']>(
			// 	collection,
			// 	[stream],
			// 	['_id', 'version'],
			// );

			// if (aggregateVersion <= lastStreamEntity?.version) {
			// 	throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, lastStreamEntity.version);
			// }

			// if (lastStreamEntity) {
			// 	await this.database
			// 		.collection<MongoDBSnapshotEntity<A>>(collection)
			// 		.updateOne({ _id: lastStreamEntity._id }, { $set: { latest: null } });
			// }

			// await this.database.collection<MongoDBSnapshotEntity<A>>(collection).insertOne({
			// 	_id: envelope.metadata.snapshotId,
			// 	streamId: stream.streamId,
			// 	payload: envelope.payload,
			// 	aggregateName: stream.aggregate,
			// 	latest: `latest#${stream.streamId}`,
			// 	...envelope.metadata,
			// });

			return envelope;
		} catch (error) {
			switch (error.constructor) {
				case SnapshotStoreVersionConflictException:
					throw error;
				default:
					throw new SnapshotStorePersistenceException(collection, error);
			}
		}
	}

	async getLastSnapshot<A extends AggregateRoot>(stream: SnapshotStream, pool?: ISnapshotPool): Promise<ISnapshot<A>> {
		// TODO: Implement
		return;
	}

	async getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		// TODO: Implement
		return new Map();
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		// TODO: Implement
		return;
	}

	async *getEnvelopes<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		// TODO: Implement
		yield [];
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		// TODO: Implement
		return;
	}

	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		// TODO: Implement
		yield [];
	}

	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		// TODO: Implement
		return new Map();
	}
}
