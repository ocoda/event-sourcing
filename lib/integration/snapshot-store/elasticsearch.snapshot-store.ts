import { Client } from '@elastic/elasticsearch';
import { StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';

export interface ElasticsearchSnapshotEnvelopeEntity<A extends AggregateRoot> {
	_index: string;
	_id: string;
	_source: {
		streamId: string;
		payload: ISnapshot<A>;
		metadata: SnapshotEnvelopeMetadata;
	};
}

export class ElasticsearchSnapshotStore extends SnapshotStore {
	constructor(private readonly client: Client) {
		super();
	}

	async setup(pool?: ISnapshotPool): Promise<void> {
		await this.client.indices.create({
			index: pool ? `${pool}-snapshots` : 'snapshots',
			body: {
				mappings: {
					properties: {
						streamId: { type: 'text', index: true },
						payload: { type: 'object' },
						metadata: {
							type: 'object',
							properties: {
								snapshotId: { type: 'keyword' },
								aggregateId: { type: 'keyword' },
								version: { type: 'integer', index: true },
								registeredOn: { type: 'date' },
							},
						},
					},
				},
			},
		});
	}

	async getSnapshots<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<ISnapshot<A>[]> {
		const query = {
			bool: {
				must: [
					{ match: { streamId } },
					...(fromVersion ? [{ range: { 'metadata.version': { gte: fromVersion } } }] : []),
				],
			},
		};

		const sort =
			direction === StreamReadingDirection.FORWARD ? { 'metadata.version': 'asc' } : { 'metadata.version': 'desc' };

		const { body } = await this.client.search({
			index: collection,
			body: { query, sort },
		});

		return body.hits.hits.map(({ _source: { payload } }: ElasticsearchSnapshotEnvelopeEntity<A>) => payload);
	}

	async getSnapshot<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		version: number,
	): Promise<ISnapshot<A>> {
		const query = {
			bool: {
				must: [{ match: { streamId } }, { match: { 'metadata.version': version } }],
			},
		};

		const { body } = await this.client.search({
			index: collection,
			body: { query },
		});

		const entity: ElasticsearchSnapshotEnvelopeEntity<A> = body.hits.hits[0];

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return entity._source.payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		{ collection, streamId, aggregateId }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
	): Promise<void> {
		const { payload, metadata } = SnapshotEnvelope.create<A>(snapshot, { aggregateId, version: aggregateVersion });

		await this.client.index({
			index: collection,
			id: metadata.snapshotId,
			body: { streamId, payload, metadata },
			refresh: 'wait_for',
		});
	}

	async getLastSnapshot<A extends AggregateRoot>({ collection, streamId }: SnapshotStream): Promise<ISnapshot<A>> {
		const query = {
			bool: {
				must: [{ match: { streamId } }],
			},
		};

		const { body } = await this.client.search({
			index: collection,
			body: {
				query,
				sort: [{ 'metadata.version': 'desc' }],
			},
			size: 1,
		});

		const entity: ElasticsearchSnapshotEnvelopeEntity<A> = body.hits.hits[0];

		if (entity) {
			return entity._source.payload;
		}
	}

	async getLastEnvelope<A extends AggregateRoot>({ collection, streamId }: SnapshotStream): Promise<
		SnapshotEnvelope<A>
	> {
		const query = {
			bool: {
				must: [{ match: { streamId } }],
			},
		};

		const { body } = await this.client.search({
			index: collection,
			body: {
				query,
				sort: [{ 'metadata.version': 'desc' }],
			},
			size: 1,
		});

		const entity: ElasticsearchSnapshotEnvelopeEntity<A> = body.hits.hits[0];

		if (entity) {
			return SnapshotEnvelope.from<A>(entity._source.payload, {
				...entity._source.metadata,
				registeredOn: new Date(entity._source.metadata.registeredOn),
			});
		}
	}

	async getEnvelopes<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): Promise<SnapshotEnvelope<A>[]> {
		const query = {
			bool: {
				must: [
					{ match: { streamId } },
					...(fromVersion ? [{ range: { 'metadata.version': { gte: fromVersion } } }] : []),
				],
			},
		};

		const sort =
			direction === StreamReadingDirection.FORWARD ? { 'metadata.version': 'asc' } : { 'metadata.version': 'desc' };

		const { body } = await this.client.search({
			index: collection,
			body: { query, sort },
		});

		return body.hits.hits.map(
			({ _source: { payload, metadata } }: ElasticsearchSnapshotEnvelopeEntity<A>) =>
				SnapshotEnvelope.from<A>(payload, { ...metadata, registeredOn: new Date(metadata.registeredOn) }),
		);
	}

	async getEnvelope<A extends AggregateRoot>(
		{ collection, streamId }: SnapshotStream,
		version: number,
	): Promise<SnapshotEnvelope<A>> {
		const query = {
			bool: {
				must: [{ match: { streamId } }, { match: { 'metadata.version': version } }],
			},
		};

		const { body } = await this.client.search({
			index: collection,
			body: { query },
		});

		const entity: ElasticsearchSnapshotEnvelopeEntity<A> = body.hits.hits[0];

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return SnapshotEnvelope.from<A>(entity._source.payload, {
			...entity._source.metadata,
			registeredOn: new Date(entity._source.metadata.registeredOn),
		});
	}
}
