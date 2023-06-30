import { Db, Document } from 'mongodb';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, SnapshotCollection, SnapshotEnvelope, SnapshotStream } from '../../models';
import { LatestSnapshotFilter, SnapshotFilter, SnapshotStore } from '../../snapshot-store';

export type MongoSnapshotEntity<A extends AggregateRoot> = {
	_id: string;
	streamId: string;
	payload: ISnapshot<A>;
	aggregateName: string;
	latest?: string;
} & Document &
	SnapshotEnvelopeMetadata;

export class MongoDBSnapshotStore extends SnapshotStore {
	constructor(readonly database: Db) {
		super();
	}

	async setup(pool?: ISnapshotPool): Promise<SnapshotCollection> {
		const collection = SnapshotCollection.get(pool);

		const [existingCollection] = await this.database.listCollections({ name: collection }).toArray();
		if (existingCollection) {
			return collection;
		}

		const snapshotCollection = await this.database.createCollection(collection);
		await snapshotCollection.createIndex({ streamId: 1, version: 1 }, { unique: true });
		await snapshotCollection.createIndex({ aggregateName: 1, latest: 1 }, { unique: false });

		return collection;
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
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

		const entity = await this.database.collection<MongoSnapshotEntity<A>>(collection).findOne({
			streamId,
			version,
		});

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return entity.payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		{ streamId, aggregateId, aggregate }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<void> {
		const collection = SnapshotCollection.get(pool);

		const { payload, metadata } = SnapshotEnvelope.create<A>(snapshot, {
			aggregateId,
			version: aggregateVersion,
		});

		const lastStreamEntity = await this.getLastStreamEntity(collection, streamId);

		if (lastStreamEntity) {
			await this.database
				.collection<MongoSnapshotEntity<A>>(collection)
				.updateOne({ _id: lastStreamEntity._id }, { $set: { latest: null } });
		}

		await this.database.collection<MongoSnapshotEntity<A>>(collection).insertOne({
			_id: metadata.snapshotId,
			streamId,
			payload,
			aggregateName: aggregate,
			latest: `latest#${streamId}`,
			...metadata,
		});
	}

	async getLastSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const entity = await this.getLastStreamEntity<A>(collection, streamId);

		if (entity) {
			return entity.payload;
		}
	}

	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const entity = await this.getLastStreamEntity<A>(collection, streamId);

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
		filter?: SnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { version: { $gte: fromVersion } }),
				},
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
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

		const entity = await this.database.collection<MongoSnapshotEntity<A>>(collection).findOne({
			streamId,
			version,
		});

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

	async *getLastEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: LatestSnapshotFilter,
		pool?: ISnapshotPool,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(pool);

		const fromId = filter?.fromId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find(
				{
					aggregateName,
					...(fromId ? { latest: { $gte: fromId } } : { latest: { $regex: /^latest/ } }),
				},
				{
					sort: { latest: -1 },
					limit,
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

	private async getLastStreamEntity<A extends AggregateRoot>(
		collection: string,
		streamId: string,
	): Promise<MongoSnapshotEntity<A>> {
		const [entity] = await this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find({ streamId }, { sort: { version: -1 }, limit: 1 })
			.toArray();

		if (entity) {
			return entity;
		}
	}
}
