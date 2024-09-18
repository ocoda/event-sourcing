import {
	AggregateRoot,
	DEFAULT_BATCH_SIZE,
	ISnapshot,
	ISnapshotCollection,
	ISnapshotPool,
	LatestSnapshotFilter,
	SnapshotCollection,
	SnapshotEnvelope,
	SnapshotFilter,
	SnapshotNotFoundException,
	SnapshotStore,
	SnapshotStream,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { Pool, PoolClient } from 'pg';
import Cursor from 'pg-cursor';
import { PostgresSnapshotEntity, PostgresSnapshotStoreConfig } from './interfaces';

export class PostgresSnapshotStore extends SnapshotStore<PostgresSnapshotStoreConfig> {
	private pool: Pool;
	private client: PoolClient;

	async start(): Promise<ISnapshotCollection> {
		this.logger.log('Starting store');
		const { pool, ...params } = this.options;

		this.pool = new Pool(params);
		this.client = await this.pool.connect();

		const collection = SnapshotCollection.get(pool);

		await this.client.query(
			`CREATE TABLE IF NOT EXISTS "${collection}" (
                stream_id VARCHAR(255) NOT NULL,
                version INT NOT NULL,
                payload JSONB NOT NULL,
                snapshot_id VARCHAR(255) NOT NULL,
                aggregate_id VARCHAR(255) NOT NULL,
                registered_on TIMESTAMP NOT NULL,
                aggregate_name VARCHAR(255) NOT NULL,
                latest VARCHAR(255),
                PRIMARY KEY (stream_id, version)
            )`,
		);

		return collection;
	}

	async stop(): Promise<void> {
		this.logger.log('Stopping store');
		this.client.release();
		await this.pool.end();
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
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
		{ streamId, aggregateId, aggregate }: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<void> {
		const collection = SnapshotCollection.get(pool);

		const { payload, metadata } = SnapshotEnvelope.create<A>(snapshot, {
			aggregateId,
			version: aggregateVersion,
		});

		const lastStreamEntity = await this.getLastStreamEntity(collection, streamId);

		if (lastStreamEntity) {
			await this.client.query(`UPDATE "${collection}" SET latest = null WHERE stream_id = $1 AND version = $2`, [
				lastStreamEntity.stream_id,
				lastStreamEntity.version,
			]);
		}

		await this.client.query(
			`
            INSERT INTO "${collection}" (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`,
			[
				streamId,
				metadata.version,
				JSON.stringify(payload),
				metadata.snapshotId,
				metadata.aggregateId,
				metadata.registeredOn,
				aggregate,
				`latest#${streamId}`,
			],
		);
	}

	async getLastSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const entity = await this.getLastStreamEntity<A>(collection, streamId);

		if (entity) {
			return entity.payload;
		}
	}

	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const entity = await this.getLastStreamEntity<A>(collection, streamId);

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
		filter?: SnapshotFilter,
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

		const cursor = this.client.query(new Cursor<Omit<PostgresSnapshotEntity<A>, 'stream_id'>>(query, params));

		let done = false;

		while (!done) {
			const rows: Array<Omit<PostgresSnapshotEntity<A>, 'stream_id'>> = await new Promise((resolve, reject) =>
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
			Omit<PostgresSnapshotEntity<A>, 'stream_id' | 'aggregate_name' | 'latest'>
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

	async *getLastEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: LatestSnapshotFilter,
		pool?: ISnapshotPool,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(pool);

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
			new Cursor<Omit<PostgresSnapshotEntity<A>, 'stream_id' | 'aggregate_name' | 'latest'>>(query, params),
		);

		let done = false;

		while (!done) {
			const rows: Array<Omit<PostgresSnapshotEntity<A>, 'stream_id' | 'aggregate_name' | 'latest'>> = await new Promise(
				(resolve, reject) => cursor.read(batch, (err, result) => (err ? reject(err) : resolve(result))),
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

	private async getLastStreamEntity<A extends AggregateRoot>(
		collection: string,
		streamId: string,
	): Promise<Omit<PostgresSnapshotEntity<A>, 'aggregate_name' | 'latest'>> {
		const { rows: entities } = await this.client.query<Omit<PostgresSnapshotEntity<A>, 'aggregate_name' | 'latest'>>(
			`SELECT stream_id, payload, aggregate_id, registered_on, snapshot_id, version
             FROM "${collection}" WHERE stream_id = $1 ORDER BY version DESC LIMIT 1`,
			[streamId],
		);
		const entity = entities[0];

		if (entity) {
			return entity;
		}
	}
}
