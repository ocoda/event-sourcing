import { ISnapshot, SnapshotEnvelopeMetadata } from '../../interfaces';
import { Db, MongoClient } from 'mongodb';
import { StreamReadingDirection } from '../../constants';
import { AggregateRoot, Id, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';
import { SnapshotNotFoundException } from '../../exceptions';

export interface MongoSnapshotEnvelopeEntity<A extends AggregateRoot> {
	_id: string;
	stream: string;
	payload: ISnapshot<A>;
	metadata: SnapshotEnvelopeMetadata;
}

export class MongoDBSnapshotStore extends SnapshotStore {
	private readonly database: Db;
	constructor(readonly client: MongoClient) {
		super();
		this.database = client.db();
	}

	async getSnapshots<A extends AggregateRoot>(
		{ name, subject }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<ISnapshot<A>[]> {
		const entities = await this.database.collection<MongoSnapshotEnvelopeEntity<A>>(subject).find(
			{
				stream: name,
				...(fromVersion && { 'metadata.sequence': { $gte: fromVersion } }),
			},
			{
				sort: { 'metadata.sequence': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
			},
		);

		return entities.map(({ payload }) => payload).toArray();
	}

	async getSnapshot<A extends AggregateRoot>(
		{ name, subject }: SnapshotStream,
		version: number,
	): Promise<ISnapshot<A>> {
		const entity = await this.database.collection<MongoSnapshotEnvelopeEntity<A>>(subject).findOne({
			stream: name,
			'metadata.sequence': version,
		});

		if (!entity) {
			throw SnapshotNotFoundException.withVersion(name, version);
		}

		return entity.payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		aggregateId: Id,
		aggregateVersion: number,
		{ name, subject }: SnapshotStream,
		snapshot: ISnapshot<A>,
	): Promise<void> {
		const { snapshotId, payload, metadata } = SnapshotEnvelope.create<A>(aggregateId, aggregateVersion, snapshot);
		await this.database.collection<MongoSnapshotEnvelopeEntity<A>>(subject).insertOne({
			_id: snapshotId,
			stream: name,
			payload,
			metadata,
		});
	}

	async getLastSnapshot<A extends AggregateRoot>({ name, subject }: SnapshotStream<A>): Promise<ISnapshot<A>> {
		const [entity] = await this.database
			.collection<MongoSnapshotEnvelopeEntity<A>>(subject)
			.find(
				{
					stream: name,
				},
				{ sort: { 'metadata.sequence': -1 }, limit: 1 },
			)
			.toArray();

		if (entity) {
			return entity.payload;
		}
	}

	async getEnvelopes<A extends AggregateRoot>(
		{ name, subject }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<SnapshotEnvelope<A>[]> {
		const entities = await this.database.collection<MongoSnapshotEnvelopeEntity<A>>(subject).find(
			{
				stream: name,
				...(fromVersion && { 'metadata.sequence': { $gte: fromVersion } }),
			},
			{
				sort: { 'metadata.sequence': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
			},
		);

		return entities.map(({ _id, payload, metadata }) => SnapshotEnvelope.from<A>(_id, payload, metadata)).toArray();
	}

	async getEnvelope<A extends AggregateRoot>(
		{ name, subject }: SnapshotStream,
		version: number,
	): Promise<SnapshotEnvelope<A>> {
		const entity = await this.database.collection<MongoSnapshotEnvelopeEntity<A>>(subject).findOne({
			stream: name,
			'metadata.sequence': version,
		});

		if (!entity) {
			throw SnapshotNotFoundException.withVersion(name, version);
		}

		return SnapshotEnvelope.from<A>(entity._id, entity.payload, entity.metadata);
	}
}
