import { Client } from '@elastic/elasticsearch';
import { StreamReadingDirection } from '../../constants';
import { SnapshotNotFoundException } from '../../exceptions';
import { ISnapshot, ISnapshotPool, SnapshotEnvelopeMetadata } from '../../interfaces';
import { AggregateRoot, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotFilter, SnapshotStore } from '../../snapshot-store';

export interface ElasticsearchSnapshotEntity<A extends AggregateRoot> {
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
				aliases: { all: {} },
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

	async *getSnapshots<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<ISnapshot<A>[]> {
		let size = filter?.limit || 10;
		let query: Record<string, any> = { bool: { must: [] } };

		filter?.snapshotStream && query.bool.must.push({ match: { streamId: filter.snapshotStream.streamId } });
		filter?.fromVersion && query.bool.must.push({ range: { 'metadata.version': { gte: filter.fromVersion } } });

		if (query.bool.must.length === 0) {
			query = { match_all: {} };
		}

		const sort =
			filter?.direction === StreamReadingDirection.BACKWARD
				? { 'metadata.version': 'desc' }
				: { 'metadata.version': 'asc' };

		const scrollSearch = this.client.helpers.scrollSearch<ElasticsearchSnapshotEntity<A>[]>({
			index: filter?.snapshotStream?.collection || 'all',
			body: { query, sort },
			size,
		});

		for await (const { body } of scrollSearch) {
			yield body.hits.hits.map(({ _source: { payload } }: ElasticsearchSnapshotEntity<A>) => payload);
		}
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

		const entity: ElasticsearchSnapshotEntity<A> = body.hits.hits[0];

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

		const entity: ElasticsearchSnapshotEntity<A> = body.hits.hits[0];

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

		const entity: ElasticsearchSnapshotEntity<A> = body.hits.hits[0];

		if (entity) {
			return SnapshotEnvelope.from<A>(entity._source.payload, {
				...entity._source.metadata,
				registeredOn: new Date(entity._source.metadata.registeredOn),
			});
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(filter?: SnapshotFilter): AsyncGenerator<SnapshotEnvelope<A>[]> {
		let size = filter?.limit || 10;
		let query: Record<string, any> = { bool: { must: [] } };

		filter?.snapshotStream && query.bool.must.push({ match: { streamId: filter.snapshotStream.streamId } });
		filter?.fromVersion && query.bool.must.push({ range: { 'metadata.version': { gte: filter.fromVersion } } });

		if (query.bool.must.length === 0) {
			query = { match_all: {} };
		}

		const sort =
			filter?.direction === StreamReadingDirection.BACKWARD
				? { 'metadata.version': 'desc' }
				: { 'metadata.version': 'asc' };

		const scrollSearch = this.client.helpers.scrollSearch<ElasticsearchSnapshotEntity<A>[]>({
			index: filter?.snapshotStream?.collection || 'all',
			body: { query, sort },
			size,
		});

		for await (const { body } of scrollSearch) {
			yield body.hits.hits.map(
				({ _source: { payload, metadata } }: ElasticsearchSnapshotEntity<A>) =>
					SnapshotEnvelope.from<A>(payload, { ...metadata, registeredOn: new Date(metadata.registeredOn) }),
			);
		}
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

		const entity: ElasticsearchSnapshotEntity<A> = body.hits.hits[0];

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return SnapshotEnvelope.from<A>(entity._source.payload, {
			...entity._source.metadata,
			registeredOn: new Date(entity._source.metadata.registeredOn),
		});
	}
}
