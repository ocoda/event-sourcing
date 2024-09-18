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
import { type Pool, createPool } from 'mariadb';
import { MariaDBSnapshotEntity, MariaDBSnapshotStoreConfig } from './interfaces';

export class MariaDBSnapshotStore extends SnapshotStore<MariaDBSnapshotStoreConfig> {
	private pool: Pool;

	async start(): Promise<ISnapshotCollection> {
		this.logger.log('Starting store');
		const { pool, ...params } = this.options;

		this.pool = createPool(params);

		const collection = SnapshotCollection.get(pool);

		await this.pool.query(
			`CREATE TABLE IF NOT EXISTS \`${collection}\` (
                stream_id VARCHAR(255) NOT NULL,
                version INT NOT NULL,
                payload JSON NOT NULL,
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
		await this.pool.end();
	}

	async *getSnapshots<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		filter?: SnapshotFilter,
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
			await this.pool.query(`UPDATE \`${collection}\` SET latest = null WHERE stream_id = ? AND version = ?`, [
				lastStreamEntity.stream_id,
				lastStreamEntity.version,
			]);
		}

		await this.pool.query(`INSERT INTO \`${collection}\` VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
			streamId,
			metadata.version,
			JSON.stringify(payload),
			metadata.snapshotId,
			metadata.aggregateId,
			metadata.registeredOn,
			aggregate,
			`latest#${streamId}`,
		]);
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
			for await (const { payload, aggregate_id, registered_on, snapshot_id, version } of stream as unknown as Omit<
				MariaDBSnapshotEntity<A>,
				'stream_id'
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

		const [entity] = await this.pool.query<MariaDBSnapshotEntity<A>[]>(
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

	async *getLastEnvelopes<A extends AggregateRoot>(
		aggregateName: string,
		filter?: LatestSnapshotFilter,
		pool?: ISnapshotPool,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const connection = this.pool.getConnection();
		const collection = SnapshotCollection.get(pool);

		const fromId = filter?.fromId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
	        SELECT payload, aggregate_id, registered_on, snapshot_id, version
	        FROM \`${collection}\`
	        WHERE aggregate_name = ?
	        AND ${fromId ? 'latest >= ?' : "latest LIKE 'latest%'"}
	        LIMIT ?
	    `;

		const params = fromId ? [aggregateName, fromId, limit] : [aggregateName, limit];

		const client = await connection;
		const stream = client.queryStream(query, params);

		try {
			let batchedSnapshots: SnapshotEnvelope<A>[] = [];
			for await (const { payload, aggregate_id, registered_on, snapshot_id, version } of stream as unknown as Omit<
				MariaDBSnapshotEntity<A>,
				'stream_id'
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

	private async getLastStreamEntity<A extends AggregateRoot>(
		collection: string,
		streamId: string,
	): Promise<Omit<MariaDBSnapshotEntity<A>, 'aggregate_name' | 'latest'>> {
		const [entity] = await this.pool.query<Omit<MariaDBSnapshotEntity<A>, 'aggregate_name' | 'latest'>[]>(
			`SELECT stream_id, payload, aggregate_id, registered_on, snapshot_id, version FROM \`${collection}\` WHERE stream_id = ? ORDER BY version DESC LIMIT 1`,
			[streamId],
		);

		if (entity) {
			return entity;
		}
	}
}
