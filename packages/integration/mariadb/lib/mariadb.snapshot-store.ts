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
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStoreCollectionCreationException,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	type SnapshotStream,
	StreamReadingDirection,
	getAggregateMetadata,
} from '@ocoda/event-sourcing';
import { type Connection, type Pool, createPool } from 'mariadb';
import type { MariaDBSnapshotEntity, MariaDBSnapshotStoreConfig } from './interfaces';

export class MariaDBSnapshotStore extends SnapshotStore<MariaDBSnapshotStoreConfig> {
	private pool: Pool;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.pool = createPool(this.options);
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		await this.pool.end();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);

		try {
			await this.pool.query(
				`CREATE TABLE IF NOT EXISTS \`${collection}\` (
                    stream_id VARCHAR(90) NOT NULL,
                    version INT NOT NULL,
                    payload JSON NOT NULL,
                    snapshot_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    registered_on TIMESTAMP NOT NULL,
                    aggregate_name VARCHAR(50) NOT NULL,
                    latest VARCHAR(100),
                    PRIMARY KEY (stream_id, version),
                    INDEX idx_aggregate_name_latest (aggregate_name, latest)
                )`,
			);

			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException(collection, error);
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const connection = this.pool.getConnection();

		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = "SELECT TABLE_NAME FROM information_schema.tables WHERE BINARY table_name LIKE '%snapshots'";

		const client = await connection;
		const stream = client.queryStream(query);

		try {
			let batchedCollections: ISnapshotCollection[] = [];
			for await (const { TABLE_NAME } of stream as unknown as Record<string, ISnapshotCollection>[]) {
				batchedCollections.push(TABLE_NAME);
				if (batchedCollections.length === batch) {
					yield batchedCollections;
					batchedCollections = [];
				}
			}
			if (batchedCollections.length > 0) {
				yield batchedCollections;
			}
		} catch (e) {
			stream.destroy();
		} finally {
			await client.release();
		}
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		const connection = this.pool.getConnection();
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
	        SELECT payload
	        FROM \`${collection}\`
	        WHERE stream_id = ?
	        ${fromVersion ? 'AND version >= ?' : ''}
	        ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
	        LIMIT ?
	    `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const client = await connection;
		const stream = client.queryStream(query, params);

		try {
			let batchedEvents: ISnapshot<A>[] = [];
			for await (const { payload } of stream as unknown as Pick<MariaDBSnapshotEntity<A>, 'payload'>[]) {
				batchedEvents.push(payload);
				if (batchedEvents.length === batch) {
					yield batchedEvents;
					batchedEvents = [];
				}
			}
			if (batchedEvents.length > 0) {
				yield batchedEvents;
			}
		} catch (e) {
			stream.destroy();
		} finally {
			await client.release();
		}
	}

	async getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.pool.query<Pick<MariaDBSnapshotEntity<A>, 'payload'>[]>(
			`SELECT payload FROM \`${collection}\` WHERE stream_id = ? AND version = ?`,
			[streamId, version],
		);

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return entity.payload;
	}

	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const connection = await this.pool.getConnection();
		const collection = SnapshotCollection.get(pool);

		try {
			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});

			const [lastStreamEntity] = await this.getLastStreamEntities<A, ['stream_id', 'version']>(
				collection,
				[stream],
				['stream_id', 'version'],
				connection,
			);

			if (aggregateVersion <= lastStreamEntity?.version) {
				throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, lastStreamEntity.version);
			}

			await connection.beginTransaction();

			if (lastStreamEntity) {
				await connection.query(`UPDATE \`${collection}\` SET latest = null WHERE stream_id = ? AND version = ?`, [
					lastStreamEntity.stream_id,
					lastStreamEntity.version,
				]);
			}

			await connection.query(`INSERT INTO \`${collection}\` VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
				stream.streamId,
				envelope.metadata.version,
				JSON.stringify(envelope.payload),
				envelope.metadata.snapshotId,
				envelope.metadata.aggregateId,
				envelope.metadata.registeredOn,
				stream.aggregate,
				`latest#${stream.streamId}`,
			]);

			await connection.commit();

			return envelope;
		} catch (error) {
			await connection.rollback();
			switch (error.constructor) {
				case SnapshotStoreVersionConflictException:
					throw error;
				default:
					throw new SnapshotStorePersistenceException(collection, error);
			}
		} finally {
			connection.release();
		}
	}

	async getLastSnapshot<A extends AggregateRoot>(stream: SnapshotStream, pool?: ISnapshotPool): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.getLastStreamEntities<A, ['payload']>(collection, [stream], ['payload']);

		if (entity) {
			return entity.payload;
		}
	}

	async getManyLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<A, ['stream_id', 'payload']>(collection, streams, [
			'stream_id',
			'payload',
		]);

		return new Map(
			entities.map(({ stream_id, payload }) => [
				streams.find(({ streamId: currentStreamId }) => currentStreamId === stream_id),
				payload,
			]),
		);
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.getLastStreamEntities<
			A,
			['payload', 'snapshot_id', 'aggregate_id', 'registered_on', 'version']
		>(collection, [stream], ['payload', 'snapshot_id', 'aggregate_id', 'registered_on', 'version']);

		if (entity) {
			return SnapshotEnvelope.from<A>(entity.payload, {
				snapshotId: entity.snapshot_id,
				aggregateId: entity.aggregate_id,
				registeredOn: entity.registered_on,
				version: entity.version,
			});
		}
	}

	async *getEnvelopes<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const connection = this.pool.getConnection();
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
	        SELECT payload, aggregate_id, registered_on, snapshot_id, version
	        FROM \`${collection}\`
	        WHERE stream_id = ?
	        ${fromVersion ? 'AND version >= ?' : ''}
	        ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
	        LIMIT ?
	    `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const client = await connection;
		const stream = client.queryStream(query, params);

		try {
			let batchedSnapshots: SnapshotEnvelope<A>[] = [];
			for await (const { payload, aggregate_id, registered_on, snapshot_id, version } of stream as unknown as Pick<
				MariaDBSnapshotEntity<A>,
				'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'
			>[]) {
				batchedSnapshots.push(
					SnapshotEnvelope.from<A>(payload, {
						aggregateId: aggregate_id,
						registeredOn: registered_on,
						snapshotId: snapshot_id,
						version,
					}),
				);
				if (batchedSnapshots.length === batch) {
					yield batchedSnapshots;
					batchedSnapshots = [];
				}
			}
			if (batchedSnapshots.length > 0) {
				yield batchedSnapshots;
			}
		} catch (e) {
			stream.destroy();
		} finally {
			await client.release();
		}
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.pool.query<
			Pick<MariaDBSnapshotEntity<A>, 'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'>[]
		>(
			`SELECT payload, aggregate_id, registered_on, snapshot_id, version FROM \`${collection}\` WHERE stream_id = ? AND version = ?`,
			[streamId, version],
		);

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return SnapshotEnvelope.from<A>(entity.payload, {
			aggregateId: entity.aggregate_id,
			registeredOn: entity.registered_on,
			snapshotId: entity.snapshot_id,
			version: entity.version,
		});
	}

	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const connection = this.pool.getConnection();
		const collection = SnapshotCollection.get(filter?.pool);
		const { streamName } = getAggregateMetadata(aggregate);

		const aggregateId = filter?.aggregateId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
	        SELECT payload, aggregate_id, registered_on, snapshot_id, version
	        FROM \`${collection}\`
	        WHERE aggregate_name = ?
	        AND ${aggregateId ? 'latest >= ?' : "latest LIKE 'latest%'"}
	        LIMIT ?
	    `;

		const params = aggregateId ? [streamName, aggregateId, limit] : [streamName, limit];

		const client = await connection;
		const stream = client.queryStream(query, params);

		try {
			let batchedSnapshots: SnapshotEnvelope<A>[] = [];
			for await (const { payload, aggregate_id, registered_on, snapshot_id, version } of stream as unknown as Pick<
				MariaDBSnapshotEntity<A>,
				'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'
			>[]) {
				batchedSnapshots.push(
					SnapshotEnvelope.from<A>(payload, {
						aggregateId: aggregate_id,
						registeredOn: registered_on,
						snapshotId: snapshot_id,
						version,
					}),
				);
				if (batchedSnapshots.length === batch) {
					yield batchedSnapshots;
					batchedSnapshots = [];
				}
			}
			if (batchedSnapshots.length > 0) {
				yield batchedSnapshots;
			}
		} catch (e) {
			stream.destroy();
		} finally {
			await client.release();
		}
	}

	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<
			A,
			['stream_id', 'payload', 'aggregate_id', 'registered_on', 'snapshot_id', 'version']
		>(collection, streams, ['stream_id', 'payload', 'aggregate_id', 'registered_on', 'snapshot_id', 'version']);

		return new Map(
			entities.map(({ stream_id, payload, aggregate_id, registered_on, snapshot_id, version }) => [
				streams.find(({ streamId: currentStreamId }) => currentStreamId === stream_id),
				SnapshotEnvelope.from<A>(payload, {
					aggregateId: aggregate_id,
					registeredOn: new Date(registered_on),
					snapshotId: snapshot_id,
					version,
				}),
			]),
		);
	}

	private async getLastStreamEntities<
		A extends AggregateRoot,
		Fields extends (keyof MariaDBSnapshotEntity<A>)[] = (keyof MariaDBSnapshotEntity<A>)[],
	>(
		collection: string,
		streams: SnapshotStream[],
		fields: Fields,
		connection?: Connection,
	): Promise<Pick<MariaDBSnapshotEntity<A>, Fields[number]>[]> {
		const latestIds = streams.map(({ streamId }) => `latest#${streamId}`);
		return (connection || this.pool).query<Pick<MariaDBSnapshotEntity<A>, Fields[number]>[]>(
			`SELECT ${fields.join(', ')} 
                FROM \`${collection}\` 
                WHERE latest IN (?)
            `,
			[latestIds],
		);
	}
}
