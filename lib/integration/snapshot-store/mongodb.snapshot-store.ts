import { ISnapshotPayload, SnapshotEnvelopeMetadata } from '../../interfaces';
import { Db } from 'mongodb';
import { StreamReadingDirection } from '../../constants';
import { Aggregate, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';
import { SnapshotNotFoundException } from '../../exceptions';

export interface SnapshotEnvelopeEntity<A extends Aggregate> {
	_id: string;
	stream: string;
	snapshotName: string;
	payload: ISnapshotPayload<A>;
	metadata: SnapshotEnvelopeMetadata;
}

export class MongoDBSnapshotStore extends SnapshotStore {
	constructor(protected readonly database: Db) {
		super();
	}

	async getSnapshots<A extends Aggregate>(
		{ name, subject }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<SnapshotEnvelope<A>[]> {
		const entities = await this.database.collection<SnapshotEnvelopeEntity<A>>(`${subject}-snapshot`).find(
			{
				stream: name,
				...(fromVersion && { 'metadata.sequence': { $gte: fromVersion } }),
			},
			{
				sort: { 'metadata.sequence': direction === StreamReadingDirection.FORWARD ? 1 : -1 },
			},
		);

		return entities.map(
			({ _id, snapshotName, payload, metadata }) => SnapshotEnvelope.from<A>(_id, snapshotName, payload, metadata),
		).toArray();
	}

	async getSnapshot<A extends Aggregate>(
		{ name, subject }: SnapshotStream,
		version: number,
	): Promise<SnapshotEnvelope<A>> {
		const entity = await this.database.collection<SnapshotEnvelopeEntity<A>>(`${subject}-snapshot`).findOne({
			stream: name,
			'metadata.sequence': version,
		});

		if (!entity) {
			throw SnapshotNotFoundException.withVersion(name, version);
		}

		return SnapshotEnvelope.from<A>(entity._id, entity.snapshotName, entity.payload, entity.metadata);
	}

	async appendSnapshots<A extends Aggregate>(
		{ name, subject }: SnapshotStream,
		envelopes: SnapshotEnvelope<A>[],
	): Promise<void> {
		await this.database.collection<SnapshotEnvelopeEntity<A>>(`${subject}-snapshot`).insertMany(
			envelopes.map(({ snapshotId, ...rest }) => ({ stream: name, _id: snapshotId, ...rest })),
		);
	}

	async getLastSnapshot<A extends Aggregate>({ name, subject }: SnapshotStream<A>): Promise<SnapshotEnvelope<A>> {
		const [entity] = await this.database
			.collection<SnapshotEnvelopeEntity<A>>(`${subject}-snapshot`)
			.find(
				{
					stream: name,
				},
				{ sort: { 'metadata.sequence': -1 }, limit: 1 },
			)
			.toArray();

		if (entity) {
			return SnapshotEnvelope.from<A>(entity._id, entity.snapshotName, entity.payload, entity.metadata)
		};
	}
}
