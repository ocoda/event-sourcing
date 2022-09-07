import { Aggregate, SnapshotEnvelope, SnapshotStream } from '../../models';
import { Client } from '@elastic/elasticsearch';
import { ISnapshotPayload, SnapshotEnvelopeMetadata } from '../../interfaces';
import { SnapshotNotFoundException } from '../../exceptions';
import { SnapshotStore } from '../../snapshot-store';
import { StreamReadingDirection } from '../../constants';

export interface ElasticsearchSnapshotEnvelopeEntity<A extends Aggregate> {
	_index: string;
	_id: string;
	_source: {
		stream: string;
		snapshotName: string;
		payload: ISnapshotPayload<A>;
		metadata: SnapshotEnvelopeMetadata;
	};
}

export class ElasticsearchSnapshotStore extends SnapshotStore {
	constructor(private readonly client: Client) {
		super();
	}

	async getSnapshots<A extends Aggregate>(
		{ name, subject }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<SnapshotEnvelope<A>[]> {
		const query = {
			bool: {
				must: [
					{ match: { stream: name } },
					...(fromVersion ? [{ range: { 'metadata.sequence': { gte: fromVersion } } }] : []),
				],
			},
		};

		const sort =
			direction === StreamReadingDirection.FORWARD ? { 'metadata.sequence': 'asc' } : { 'metadata.sequence': 'desc' };

		const { body } = await this.client.search({
			index: subject,
			body: { query, sort },
		});

		return body.hits.hits.map(({
			_id,
			_source: { snapshotName, payload, metadata },
		}: ElasticsearchSnapshotEnvelopeEntity<A>) => {
			return SnapshotEnvelope.from<A>(_id, snapshotName, payload, metadata);
		});
	}

	async getSnapshot<A extends Aggregate>(
		{ name, subject }: SnapshotStream,
		version: number,
	): Promise<SnapshotEnvelope<A>> {
		const query = {
			bool: {
				must: [{ match: { stream: name } }, { match: { 'metadata.sequence': version } }],
			},
		};

		const { body } = await this.client.search({
			index: subject,
			body: { query },
		});

		const entity: ElasticsearchSnapshotEnvelopeEntity<A> = body.hits.hits[0];

		if (!entity) {
			throw SnapshotNotFoundException.withVersion(name, version);
		}

		return SnapshotEnvelope.from<A>(
			entity._id,
			entity._source.snapshotName,
			entity._source.payload,
			entity._source.metadata,
		);
	}

	async appendSnapshots<A extends Aggregate>(
		{ name, subject }: SnapshotStream,
		envelopes: SnapshotEnvelope<A>[],
	): Promise<void> {
		const body = envelopes.flatMap(
			({ snapshotId, ...rest }) => [{ index: { _index: subject, _id: snapshotId } }, { stream: name, ...rest }],
		);

		await this.client.bulk({ index: subject, body, refresh: 'wait_for' });
	}

	async getLastSnapshot<A extends Aggregate>({ name, subject }: SnapshotStream<A>): Promise<SnapshotEnvelope<A>> {
		const query = {
			bool: {
				must: [{ match: { stream: name } }],
			},
		};

		const { body } = await this.client.search({
			index: subject,
			body: {
				query,
				sort: [{ 'metadata.sequence': 'desc' }],
			},
			size: 1,
		});

		const entity: ElasticsearchSnapshotEnvelopeEntity<A> = body.hits.hits[0];

		if (entity) {
			return SnapshotEnvelope.from<A>(
				entity._id,
				entity._source.snapshotName,
				entity._source.payload,
				entity._source.metadata,
			);
		}
	}
}
