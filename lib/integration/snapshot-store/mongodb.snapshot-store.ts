import { Db } from 'mongodb';
import { StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';

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

	async setup(pool?: ISnapshotPool): Promise<void> {
		const snapshotCollection = await this.database.createCollection<MongoSnapshotEntity>(
			pool ? `${pool}-snapshots` : 'snapshots',
		);
		await snapshotCollection.createIndex({ streamId: 1, 'metadata.version': 1 }, { unique: true });
	}

	async getSnapshots<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<ISnapshot<A>[]> {
		return this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find(
				{
					streamId,
					...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
				},
				{
					sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
				},
			)
			.map(({ payload }) => payload)
			.toArray();
	}

	async getSnapshot<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		version: number,
	): Promise<ISnapshot<A>> {
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
		{ collection, streamId, aggregateId }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
	): Promise<void> {
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

	async getLastSnapshot<A extends AggregateRoot>({ collection, streamId }: SnapshotStream): Promise<ISnapshot<A>> {
		const [entity] = await this.database
			.collection<MongoSnapshotEntity<A>>(collection)
			.find({ streamId }, { sort: { 'metadata.version': -1 }, limit: 1 })
			.toArray();

		if (entity) {
			return entity.payload;
		}
	}

	async getEnvelopes<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<SnapshotEnvelope<A>[]> {
		const entities = this.database.collection<MongoSnapshotEntity<A>>(collection).find(
			{
				streamId,
				...(fromVersion && { 'metadata.version': { $gte: fromVersion } }),
			},
			{
				sort: { 'metadata.version': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
			},
		);

		return entities.map(({ payload, metadata }) => SnapshotEnvelope.from<A>(payload, metadata)).toArray();
	}

	async getEnvelope<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		version: number,
	): Promise<SnapshotEnvelope<A>> {
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
