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
import { Pool, escapeIdentifier } from 'pg';
import type { PostgresSnapshotEntity, PostgresSnapshotStoreConfig } from './interfaces/index.js';
import { UNIQUE_VIOLATION, ensureTable, hasErrorCode, readInBatches, withTransaction } from './postgres.helpers.js';

type PostgresSnapshotEnvelopeEntity<A extends AggregateRoot> = Pick<
	PostgresSnapshotEntity<A>,
	'payload' | 'aggregate_id' | 'registered_on' | 'snapshot_id' | 'version'
>;

export class PostgresSnapshotStore extends SnapshotStore<PostgresSnapshotStoreConfig> {
	private pool: Pool;

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		this.pool = new Pool(this.options);
		// Idle connections that fail are discarded by the pool, without a listener the error would crash the process
		this.pool.on('error', (error) => this.logger.error(`Idle database connection failed: ${error.message}`));

		// Fail fast when the database can't be reached
		const client = await this.pool.connect();
		client.release();
	}

	public async disconnect(): Promise<void> {
		this.logger.log('Stopping store');
		await this.pool.end();
	}

	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);

		try {
			await ensureTable(this.pool, this.logger, {
				table: collection,
				definition: `
                    stream_id VARCHAR(90) NOT NULL,
                    version INT NOT NULL,
                    payload JSONB NOT NULL,
                    snapshot_id VARCHAR(40) NOT NULL,
                    aggregate_id VARCHAR(40) NOT NULL,
                    registered_on TIMESTAMP NOT NULL,
                    aggregate_name VARCHAR(50) NOT NULL,
                    latest VARCHAR(100),
                    PRIMARY KEY (stream_id, version)
                `,
				index: { suffix: 'aggregate_name_latest', columns: ['aggregate_name', 'latest'] },
			});

			return collection;
		} catch (err) {
			throw new SnapshotStoreCollectionCreationException(collection, err);
		}
	}

	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `SELECT tablename FROM pg_catalog.pg_tables WHERE tablename LIKE '%snapshots'`;

		for await (const rows of readInBatches<{ tablename: ISnapshotCollection }>(this.pool, query, [], batch)) {
			yield rows.map(({ tablename }) => tablename);
		}
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
	        FROM ${escapeIdentifier(collection)}
	        WHERE stream_id = $1
	        ${fromVersion ? 'AND version >= $2' : ''}
	        ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
	        LIMIT ${fromVersion ? '$3' : '$2'}
	    `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		for await (const rows of readInBatches<Pick<PostgresSnapshotEntity<A>, 'payload'>>(
			this.pool,
			query,
			params,
			batch,
		)) {
			yield rows.map(({ payload }) => payload);
		}
	}

	async getSnapshot<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		const collection = SnapshotCollection.get(pool);

		const { rows: entities } = await this.pool.query<Pick<PostgresSnapshotEntity<A>, 'payload'>>(
			`SELECT payload FROM ${escapeIdentifier(collection)} WHERE stream_id = $1 AND version = $2`,
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
		const collection = SnapshotCollection.get(pool);
		const table = escapeIdentifier(collection);

		try {
			// The version check, flag update and insert run in one transaction, so they either all apply or none do
			return await withTransaction(this.pool, async (client) => {
				// Serialize appends to the same stream, so concurrent writers can't both claim the 'latest' flag
				await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [collection, stream.streamId]);

				const envelope = SnapshotEnvelope.create<A>(snapshot, {
					aggregateId: stream.aggregateId,
					version: aggregateVersion,
				});

				const lastVersion = await this.getLatestVersion(client, table, stream);

				if (lastVersion !== undefined && aggregateVersion <= lastVersion) {
					throw new SnapshotStoreVersionConflictException(stream, aggregateVersion, lastVersion);
				}

				if (lastVersion !== undefined) {
					// Unflags every snapshot of the stream, which also repairs streams that ended up with several
					await client.query(`UPDATE ${table} SET latest = null WHERE stream_id = $1 AND latest = $2`, [
						stream.streamId,
						`latest#${stream.streamId}`,
					]);
				}

				await client.query(
					`
            INSERT INTO ${table} (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest)
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

				return envelope;
			});
		} catch (error) {
			if (error instanceof SnapshotStoreVersionConflictException) {
				throw error;
			}

			// A writer that doesn't take the stream lock appended the same version concurrently
			if (hasErrorCode(error, UNIQUE_VIOLATION)) {
				const latestVersion = await this.getLatestVersion(this.pool, table, stream).catch(() => aggregateVersion);
				throw new SnapshotStoreVersionConflictException(
					stream,
					aggregateVersion,
					latestVersion ?? aggregateVersion,
					error,
				);
			}

			throw new SnapshotStorePersistenceException(collection, error);
		}
	}

	/**
	 * Resolves the version of the snapshot flagged as the latest of a stream.
	 */
	private async getLatestVersion(
		connection: Pick<Pool, 'query'>,
		table: string,
		{ streamId }: SnapshotStream,
	): Promise<number | undefined> {
		const { rows } = await connection.query<{ version: number | null }>(
			`SELECT MAX(version) AS version FROM ${table} WHERE stream_id = $1 AND latest = $2`,
			[streamId, `latest#${streamId}`],
		);

		return rows[0]?.version ?? undefined;
	}

	async getLastSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A> | void> {
		const collection = SnapshotCollection.get(pool);

		const [entity] = await this.getLastStreamEntities<A, ['payload']>(collection, [stream], ['payload']);

		if (entity) {
			return entity.payload;
		}
	}

	async getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const collection = SnapshotCollection.get(pool);

		const entities = await this.getLastStreamEntities<A, ['stream_id', 'payload']>(collection, streams, [
			'stream_id',
			'payload',
		]);

		return entities.reduce((acc, { stream_id, payload }) => {
			const stream = streams.find(({ streamId: currentStreamId }) => currentStreamId === stream_id);

			if (stream) {
				acc.set(stream, payload);
			}

			return acc;
		}, new Map<SnapshotStream, ISnapshot<A>>());
	}

	async getLastEnvelope<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void> {
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
	        FROM ${escapeIdentifier(collection)}
	        WHERE stream_id = $1
	        ${fromVersion ? 'AND version >= $2' : ''}
	        ORDER BY version ${direction === StreamReadingDirection.FORWARD ? 'ASC' : 'DESC'}
	        LIMIT ${fromVersion ? '$3' : '$2'}
	    `;

		const params = fromVersion ? [streamId, fromVersion, limit] : [streamId, limit];

		for await (const rows of readInBatches<PostgresSnapshotEnvelopeEntity<A>>(this.pool, query, params, batch)) {
			yield rows.map((row) => this.toEnvelope(row));
		}
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		const { rows: entities } = await this.pool.query<PostgresSnapshotEnvelopeEntity<A>>(
			`SELECT payload, aggregate_id, registered_on, snapshot_id, version
            FROM ${escapeIdentifier(collection)} WHERE stream_id = $1 AND version = $2`,
			[streamId, version],
		);
		const entity = entities[0];

		if (!entity) {
			throw new SnapshotNotFoundException(streamId, version);
		}

		return this.toEnvelope(entity);
	}

	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);
		const { streamName } = getAggregateMetadata(aggregate);

		const aggregateId = filter?.aggregateId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const query = `
            SELECT payload, aggregate_id, registered_on, snapshot_id, version
            FROM ${escapeIdentifier(collection)}
            WHERE aggregate_name = $1
            AND ${aggregateId ? 'latest >= $2' : "latest LIKE 'latest%'"}
            ORDER BY latest DESC
            LIMIT ${aggregateId ? '$3' : '$2'}
        `;

		const params = aggregateId ? [streamName, aggregateId, limit] : [streamName, limit];

		for await (const rows of readInBatches<PostgresSnapshotEnvelopeEntity<A>>(this.pool, query, params, batch)) {
			yield rows.map((row) => this.toEnvelope(row));
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

		return entities.reduce((acc, { stream_id, payload, aggregate_id, registered_on, snapshot_id, version }) => {
			const stream = streams.find(({ streamId: currentStreamId }) => currentStreamId === stream_id);

			if (stream) {
				acc.set(
					stream,
					SnapshotEnvelope.from<A>(payload, {
						aggregateId: aggregate_id,
						registeredOn: new Date(registered_on),
						snapshotId: snapshot_id,
						version,
					}),
				);
			}

			return acc;
		}, new Map<SnapshotStream, SnapshotEnvelope<A>>());
	}

	private async getLastStreamEntities<
		A extends AggregateRoot,
		Fields extends (keyof PostgresSnapshotEntity<A>)[] = (keyof PostgresSnapshotEntity<A>)[],
	>(
		collection: string,
		streams: SnapshotStream[],
		fields: Fields,
	): Promise<Pick<PostgresSnapshotEntity<A>, Fields[number]>[]> {
		const latestIds = streams.map(({ streamId }) => `latest#${streamId}`);
		const { rows: entities } = await this.pool.query<Pick<PostgresSnapshotEntity<A>, Fields[number]>>(
			`SELECT ${fields.join(', ')}
                FROM ${escapeIdentifier(collection)}
                WHERE latest = ANY ($1)
             `,
			[latestIds],
		);

		return entities;
	}

	private toEnvelope<A extends AggregateRoot>({
		payload,
		aggregate_id,
		registered_on,
		snapshot_id,
		version,
	}: PostgresSnapshotEnvelopeEntity<A>): SnapshotEnvelope<A> {
		return SnapshotEnvelope.from<A>(payload, {
			aggregateId: aggregate_id,
			registeredOn: registered_on,
			snapshotId: snapshot_id,
			version,
		});
	}
}
