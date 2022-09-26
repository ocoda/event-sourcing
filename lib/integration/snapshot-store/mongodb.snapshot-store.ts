import { Db } from 'mongodb';
import { DEFAULT_BATCH_SIZE, StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, SnapshotCollection, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotFilter, SnapshotStore, StreamSnapshotFilter } from '../../snapshot-store';

export interface MongoSnapshotEntity<A extends AggregateRoot = AggregateRoot> {
	_id: string;
	streamId: string;
	payload: ISnapshot<A>;
	metadata: SnapshotEnvelopeMetadata;
}

export class MongoDBSnapshotStore extends SnapshotStore {
	constructor(readonly database: Db) {
		super();
	}

	async setup(pool?: ISnapshotPool): Promise<SnapshotCollection> {
		const collection = SnapshotCollection.get(pool);

		const snapshotCollection = await this.database.createCollection<MongoSnapshotEntity>(collection);
		await snapshotCollection.createIndex({ streamId: 1, 'metadata.version': 1 }, { unique: true });

		return collection;
	}

	async *getSnapshots<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<ISnapshot<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		let snapshotStream = filter?.snapshotStream;
		let fromVersion = snapshotStream && ((filter as StreamSnapshotFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find(
				{
					...(snapshotStream && { streamId: snapshotStream.streamId }),
					...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					skip,
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
			'metadata.version': version,
		});

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return entity.payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		{ streamId, aggregateId }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<void> {
		const collection = SnapshotCollection.get(pool);

		const { payload, metadata } = SnapshotEnvelope.create<A>(snapshot, {
			aggregateId,
			version: aggregateVersion,
		});

		await this.database.collection<MongoSnapshotEntity<A>>(collection).insertOne({
			_id: metadata.snapshotId,
			streamId,
			payload,
			metadata,
		});
	}

	async getLastSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find({ streamId }, { sort: { 'metadata.version': -1 }, limit: 1 })
			.toArray();

		if (entity) {
			return entity.payload;
		}
	}

	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find({ streamId }, { sort: { 'metadata.version': -1 }, limit: 1 })
			.toArray();

		if (entity) {
			return SnapshotEnvelope.from<A>(entity.payload, entity.metadata);
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		let snapshotStream = filter?.snapshotStream;
		let fromVersion = snapshotStream && ((filter as StreamSnapshotFilter).fromVersion || 0);
		let direction = filter?.direction || StreamReadingDirection.FORWARD;
		let limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		let skip = filter?.skip;
		let batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find(
				{
					...(snapshotStream && { streamId: snapshotStream.streamId }),
					...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					skip,
					limit,
				},
			)
			.map(({ payload, metadata }) => SnapshotEnvelope.from<A>(payload, metadata));

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
			'metadata.version': version,
		});

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return SnapshotEnvelope.from<A>(entity.payload, entity.metadata);
	}
}
