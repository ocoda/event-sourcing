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
} from '@ocoda/event-sourcing';
import { Pool, type PoolClient } from 'pg';
import Cursor from 'pg-cursor';
import type { PostgresSnapshotEntity, PostgresSnapshotStoreConfig } from './interfaces';

export class PostgresSnapshotStore extends SnapshotStore<PostgresSnapshotStoreConfig> {
	private pool: Pool;
	private client: PoolClient;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.pool = new Pool(this.options);
		this.client = await this.pool.connect();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		this.client.release();
		await this.pool.end();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const connection = await this.pool.connect();
		const collection = SnapshotCollection.get(pool);

		try {
			await connection.query('BEGIN');
			await connection.query(
				`CREATE TABLE IF NOT EXISTS "${collection}" (
                    stream_id VARCHAR(90) NOT NULL,
                    version INT NOT NULL,
                    payload JSONB NOT NULL,
                    snapshot_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    registered_on TIMESTAMP NOT NULL,
                    aggregate_name VARCHAR(50) NOT NULL,
                    latest VARCHAR(100),
                    PRIMARY KEY (stream_id, version)
                )`,
			);
			await connection.query(
				`CREATE INDEX IF NOT EXISTS "idx_aggregate_name_latest" ON "${collection}" (aggregate_name, latest)`,
			);
			await connection.query('COMMIT');

			return collection;
		} catch (err) {
			await connection.query('ROLLBACK');
			throw new SnapshotStoreCollectionCreationException(collection, err);
		} finally {
			connection.release();
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `SELECT tablename FROM pg_catalog.pg_tables WHERE tablename LIKE '%snapshots'`;

		const cursor = this.client.query(new Cursor<Record<string, ISnapshotCollection>>(query));

		let done = false;

		while (!done) {
			const rows: Array<Record<string, ISnapshotCollection>> = await new Promise((resolve, reject) =>
				cursor.read(batch, (err, result) => (err ? reject(err) : resolve(result))),
			);

			if (rows.length === 0) {
				done = true;
			} else {
				const collections = rows.map(({ tablename }) => tablename);
				yield collections;
			}
		}

		cursor.close(() => {});
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
	        SELECT payload
	        FROM "${collection}"
	        WHERE stream_id = $1
	        ${fromVersion ? 'AND version >= $2' : ''}
	        ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
	        LIMIT ${fromVersion ? '$3' : '$2'}
	    `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const cursor = this.client.query(new Cursor<Pick<PostgresSnapshotEntity<A>, 'payload'>>(query, params));

		let done = false;

		while (!done) {
			const rows: Array<Pick<PostgresSnapshotEntity<A>, 'payload'>> = await new Promise((resolve, reject) =>
				cursor.read(batch, (err, result) => (err ? reject(err) : resolve(result))),
			);

			if (rows.length === 0) {
				done = true;
			} else {
				yield rows.map(({ payload }) => payload);
			}
		}

		cursor.close(() => {});
	}

	async getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const { rows: entities } = await this.client.query<Pick<PostgresSnapshotEntity<A>, 'payload'>>(
			`SELECT payload FROM "${collection}" WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

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
		const connection = await this.pool.connect();
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

			await connection.query('BEGIN');
			if (lastStreamEntity) {
				await this.client.query(`UPDATE "${collection}" SET latest = null WHERE stream_id = $1 AND version = $2`, [
					lastStreamEntity.stream_id,
					lastStreamEntity.version,
				]);
			}

			await connection.query(
				`
            INSERT INTO "${collection}" (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`,
				[
					stream.streamId,
					envelope.metadata.version,
					JSON.stringify(envelope.payload),
					envelope.metadata.snapshotId,
					envelope.metadata.aggregateId,
					envelope.metadata.registeredOn,
					stream.aggregate,
					`latest#${stream.streamId}`,
				],
			);
			await connection.query('COMMIT');

			return envelope;
		} catch (error) {
			await connection.query('ROLLBACK');
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
		const collection = SnapshotCollection.get(filter?.pool);

		const fromVersion = filter?.fromVersion;
		const direction = filter?.direction || StreamReadingDirection.FORWARD;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
	        SELECT payload, aggregate_id, registered_on, snapshot_id, version
	        FROM "${collection}"
	        WHERE stream_id = $1
	        ${fromVersion ? 'AND version >= $2' : ''}
	        ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
	        LIMIT ${fromVersion ? '$3' : '$2'}
	    `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		const cursor = this.client.query(
			new Cursor<
				Pick<PostgresSnapshotEntity<A>, 'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'>
			>(query, params),
		);

		let done = false;

		while (!done) {
			const rows: Array<
				Pick<PostgresSnapshotEntity<A>, 'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'>
			> = await new Promise((resolve, reject) =>
				cursor.read(batch, (err, result) => (err ? reject(err) : resolve(result))),
			);

			if (rows.length === 0) {
				done = true;
			} else {
				yield rows.map(({ payload, aggregate_id, registered_on, snapshot_id, version }) =>
					SnapshotEnvelope.from<A>(payload, {
						aggregateId: aggregate_id,
						registeredOn: registered_on,
						snapshotId: snapshot_id,
						version,
					}),
				);
			}
		}

		cursor.close(() => {});
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const { rows: entities } = await this.client.query<
			Pick<PostgresSnapshotEntity<A>, 'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'>
		>(
			`SELECT payload, aggregate_id, registered_on, snapshot_id, version
            FROM "${collection}" WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

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

	async *getLastAggregateEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);

		const fromId = filter?.fromId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT payload, aggregate_id, registered_on, snapshot_id, version
            FROM "${collection}"
            WHERE aggregate_name = $1
            AND ${fromId ? 'latest >= $2' : "latest LIKE 'latest%'"}
            ORDER BY latest DESC
            LIMIT ${fromId ? '$3' : '$2'}
        `;

		const params = fromId ? [aggregateName, fromId, limit] : [aggregateName, limit];

		const cursor = this.client.query(
			new Cursor<
				Pick<PostgresSnapshotEntity<A>, 'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'>
			>(query, params),
		);

		let done = false;

		while (!done) {
			const rows: Array<
				Pick<PostgresSnapshotEntity<A>, 'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'>
			> = await new Promise((resolve, reject) =>
				cursor.read(batch, (err, result) => (err ? reject(err) : resolve(result))),
			);

			if (rows.length === 0) {
				done = true;
			} else {
				yield rows.map(({ payload, aggregate_id, registered_on, snapshot_id, version }) =>
					SnapshotEnvelope.from<A>(payload, {
						aggregateId: aggregate_id,
						registeredOn: registered_on,
						snapshotId: snapshot_id,
						version,
					}),
				);
			}
		}

		cursor.close(() => {});
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
		Fields extends (keyof PostgresSnapshotEntity<A>)[] = (keyof PostgresSnapshotEntity<A>)[],
	>(
		collection: string,
		streams: SnapshotStream[],
		fields: Fields,
		connection?: PoolClient,
	): Promise<Pick<PostgresSnapshotEntity<A>, Fields[number]>[]> {
		const latestIds = streams.map(({ streamId }) => `latest#${streamId}`);
		const { rows: entities } = await (connection || this.client).query<Pick<PostgresSnapshotEntity<A>, Fields[number]>>(
			`SELECT ${fields.join(', ')}
                FROM "${collection}" 
                WHERE latest = ANY ($1)
             `,
			[latestIds],
		);

		return entities;
	}
}
