import { Aggregate, Id, SnapshotEnvelope, SnapshotStream } from '../../models';
import { Client } from '@elastic/elasticsearch';
import { ISnapshot, SnapshotEnvelopeMetadata } from '../../interfaces';
import { SnapshotNotFoundException } from '../../exceptions';
import { SnapshotStore } from '../../snapshot-store';
import { StreamReadingDirection } from '../../constants';

export interface ElasticsearchSnapshotEnvelopeEntity<A extends Aggregate> {
	_index: string;
	_id: string;
	_source: {
		stream: string;
		payload: ISnapshot<A>;
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
	): Promise<ISnapshot<A>[]> {
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

		return body.hits.hits.map(({ _source: { payload } }: ElasticsearchSnapshotEnvelopeEntity<A>) => payload);
	}

	async getSnapshot<A extends Aggregate>({ name, subject }: SnapshotStream, version: number): Promise<ISnapshot<A>> {
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

		return entity._source.payload;
	}

	async appendSnapshot<A extends Aggregate>(
		aggregateId: Id,
		aggregateVersion: number,
		{ name, subject }: SnapshotStream,
		snapshot: ISnapshot<A>,
	): Promise<void> {
		const { snapshotId, payload, metadata } = SnapshotEnvelope.create<A>(aggregateId, aggregateVersion, snapshot);

		await this.client.index({
			index: subject,
			id: snapshotId,
			body: { stream: name, payload, metadata },
			refresh: 'wait_for',
		});
	}

	async getLastSnapshot<A extends Aggregate>({ name, subject }: SnapshotStream<A>): Promise<ISnapshot<A>> {
		const query = {
			bool: {
				must: [{ match: { stream: name } }],
			},
		};

		try {
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
				return entity._source.payload;
			}
		} catch (error) {
			if (error.meta.statusCode === 404) {
				return;
			}
			throw error;
		}
	}

	async getEnvelopes<A extends Aggregate>(
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

		return body.hits.hits.map(
			({ _id, _source: { payload, metadata } }: ElasticsearchSnapshotEnvelopeEntity<A>) =>
				SnapshotEnvelope.from<A>(_id, payload, metadata),
		);
	}

	async getEnvelope<A extends Aggregate>(
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

		return SnapshotEnvelope.from<A>(entity._id, entity._source.payload, entity._source.metadata);
	}
}
