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
	type MigrationReport,
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
import { type ClientSession, type Collection, type Db, MongoClient } from 'mongodb';
import type { MongoDBMigrationOptions, MongoDBSnapshotEntity, MongoDBSnapshotStoreConfig } from './interfaces/index.js';
import { migrateSnapshotCollections } from './migration/snapshots.js';
import {
	CATALOG_COLLECTION,
	type CatalogDocument,
	SCHEMA_VERSION,
	SNAPSHOT_INDEXES,
	catalogDdl,
	catalogExists,
	hasLatestUniqueIndex,
	readCollectionShape,
	snapshotCollectionDdl,
} from './mongodb.schema.js';
import { type MongoDBTopology, detectTopology } from './mongodb.topology.js';
import {
	APPEND_LIMITS,
	backoff,
	batchCursor,
	duplicateKeyOf,
	hasErrorLabel,
	isNamespaceExistsError,
} from './mongodb.utils.js';

type SnapshotDocument = MongoDBSnapshotEntity<AggregateRoot>;

/** The fields of a snapshot document an envelope is read from. */
const ENVELOPE_PROJECTION = {
	_id: 0,
	streamId: 1,
	payload: 1,
	aggregateId: 1,
	registeredOn: 1,
	snapshotId: 1,
	version: 1,
};

/**
 * The MongoDB snapshot store (schema v2, ADR 0002 §4).
 *
 * The latest snapshot of a stream is flagged (`latest: 'latest#<streamId>'`), and a unique partial index allows one
 * flag per stream; the other snapshots have no `latest` field. The last snapshot of a stream is the one with the
 * highest version, which the flag follows. On a replica set, an append unflags the previous snapshot and inserts the
 * new one in one transaction; on a standalone server it re-flags the previous snapshot when the insert fails.
 *
 * A 3.x collection (without the unique index) keeps working with a warning until `migrate()` repairs its flags.
 */
export class MongoDBSnapshotStore extends SnapshotStore<MongoDBSnapshotStoreConfig> {
	private client?: MongoClient;
	private database!: Db;
	private topology: MongoDBTopology = 'standalone';
	/** Collections that are known to exist, so that appends don't have to look them up on every write. */
	private readonly knownCollections = new Set<string>();
	/** The 3.x collections the store warned about, once each. */
	private readonly warnedLegacyCollections = new Set<string>();

	/**
	 * Migrates the 3.x snapshot collections of a database to schema v2, without bootstrapping the application. See
	 * `migrate()`.
	 */
	static async migrate(
		config: Omit<MongoDBSnapshotStoreConfig, 'driver'>,
		options?: MongoDBMigrationOptions,
	): Promise<MigrationReport> {
		const store = new MongoDBSnapshotStore({ ...config, driver: MongoDBSnapshotStore });
		await store.connect();
		try {
			return await store.migrate(options);
		} finally {
			await store.disconnect();
		}
	}

	public async connect(): Promise<void> {
		this.logger.log('Starting store');
		const { url, ddl: _ddl, useDefaultPool: _useDefaultPool, driver: _driver, ...params } = this.options;
		const client = await new MongoClient(url, params).connect();
		try {
			this.topology = await detectTopology(client);
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
		this.client = client;
		this.database = client.db();
	}

	public async disconnect(): Promise<void> {
		const client = this.client;
		if (!client) {
			return;
		}
		this.logger.log('Stopping store');
		this.client = undefined;
		this.knownCollections.clear();
		await client.close();
	}

	/**
	 * Creates the collection of a pool with schema v2 and registers it. A 3.x collection is registered with schema
	 * version 1 and keeps working, with a warning.
	 */
	public async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		const collection = SnapshotCollection.get(pool);
		const ddl = this.options.ddl ?? 'auto';

		try {
			const shape = await readCollectionShape(this.database, collection);
			let schemaVersion = SCHEMA_VERSION;
			if (!shape.exists) {
				if (ddl === 'none') {
					const statements = [
						...((await catalogExists(this.database)) ? [] : [catalogDdl()]),
						...snapshotCollectionDdl(collection),
					];
					throw new Error(`The store runs with ddl: 'none'; create the collection with: ${statements.join('; ')}`);
				}
				await this.createCollection(collection);
			} else if (!hasLatestUniqueIndex(shape.indexes)) {
				schemaVersion = 1;
				if (!this.warnedLegacyCollections.has(collection)) {
					this.warnedLegacyCollections.add(collection);
					this.logger.warn(
						`The ${collection} collection has the 3.x snapshot schema: it keeps working, but racing appends can flag several latest snapshots. Migrate it with MongoDBSnapshotStore.migrate(config, { dryRun: true }), then migrate().`,
					);
				}
			}
			if (ddl === 'none' && !(await catalogExists(this.database))) {
				throw new Error(`The store runs with ddl: 'none'; create the catalog with: ${catalogDdl()}`);
			}
			await this.catalog().updateOne(
				{ _id: collection },
				{ $setOnInsert: { kind: 'snapshots' }, $set: { schemaVersion } },
				{ upsert: true },
			);

			this.knownCollections.add(collection);
			return collection;
		} catch (error) {
			throw new SnapshotStoreCollectionCreationException({ collection }, { cause: error });
		}
	}

	/**
	 * Lists the snapshot collections the catalog registers, in batches.
	 */
	public async *listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]> {
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;
		const cursor = this.catalog()
			.find({ kind: 'snapshots' }, { projection: { _id: 1 }, sort: { _id: 1 } })
			.map(({ _id }) => _id as ISnapshotCollection);

		yield* batchCursor(cursor, batch);
	}

	async *getSnapshots<A extends AggregateRoot>(
		stream: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]> {
		for await (const envelopes of this.getEnvelopes<A>(stream, filter)) {
			yield envelopes.map(({ payload }) => payload);
		}
	}

	async getSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>> {
		return (await this.getEnvelope<A>(stream, version, pool)).payload;
	}

	/**
	 * Appends a snapshot and flags it as the latest of its stream. It has to have a higher version than the last
	 * snapshot of the stream.
	 */
	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		aggregateVersion: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);

		try {
			await this.assertCollectionExists(collection);

			const envelope = SnapshotEnvelope.create<A>(snapshot, {
				aggregateId: stream.aggregateId,
				version: aggregateVersion,
			});
			const entity: SnapshotDocument = {
				_id: envelope.metadata.snapshotId,
				streamId: stream.streamId,
				payload: envelope.payload,
				aggregateName: stream.aggregate,
				latest: latestKeyOf(stream.streamId),
				...envelope.metadata,
			};

			const deadline = Date.now() + APPEND_LIMITS.transactionBudgetMs;
			for (let attempt = 1; ; attempt++) {
				const target = { collection, stream, pool };
				const outcome =
					this.topology === 'standalone'
						? await this.appendWithRepair(target, entity)
						: await this.appendInTransaction(target, entity);
				if (outcome === 'appended') {
					return envelope;
				}
				// Another append flagged its snapshot meanwhile: read the stream again
				if (Date.now() >= deadline) {
					throw new Error(
						`Appends to the ${stream.streamId} stream kept racing for ${APPEND_LIMITS.transactionBudgetMs} ms`,
					);
				}
				await backoff(attempt);
			}
		} catch (error) {
			if (error instanceof SnapshotStoreVersionConflictException) {
				throw error;
			}
			throw new SnapshotStorePersistenceException({ collection }, { cause: error });
		}
	}

	async getLastSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A> | void> {
		return (await this.getLastEnvelope<A>(stream, pool))?.payload;
	}

	async getLastSnapshots<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		const envelopes = await this.getManyLastSnapshotEnvelopes<A>(streams, pool);
		return new Map([...envelopes].map(([stream, { payload }]) => [stream, payload]));
	}

	/**
	 * The snapshot with the highest version of the stream.
	 */
	async getLastEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void> {
		const collection = SnapshotCollection.get(pool);
		const entity = await this.snapshots(collection).findOne(
			{ streamId },
			{ sort: { version: -1 }, projection: ENVELOPE_PROJECTION },
		);
		if (entity) {
			return toEnvelope<A>(entity);
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

		const cursor = this.snapshots(collection)
			.find(
				{ streamId, ...(fromVersion && { version: { $gte: fromVersion } }) },
				{
					sort: { version: direction === StreamReadingDirection.FORWARD ? 1 : -1 },
					limit,
					projection: ENVELOPE_PROJECTION,
				},
			)
			.map((entity) => toEnvelope<A>(entity));

		yield* batchCursor(cursor, batch);
	}

	async getEnvelope<A extends AggregateRoot>(
		{ streamId }: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>> {
		const collection = SnapshotCollection.get(pool);
		const entity = await this.snapshots(collection).findOne({ streamId, version }, { projection: ENVELOPE_PROJECTION });
		if (!entity) {
			throw new SnapshotNotFoundException({ streamId, version, pool });
		}
		return toEnvelope<A>(entity);
	}

	/**
	 * The latest snapshot of every stream of an aggregate, in descending binary order of the aggregate ids.
	 * `filter.aggregateId` is an exclusive cursor: only the streams after it in that order are read.
	 */
	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const collection = SnapshotCollection.get(filter?.pool);
		const { streamName } = getAggregateMetadata(aggregate);

		const aggregateId = filter?.aggregateId;
		const limit = filter?.limit || Number.MAX_SAFE_INTEGER;
		const batch = filter?.batch || DEFAULT_BATCH_SIZE;

		const cursor = this.snapshots(collection)
			.find(
				{
					aggregateName: streamName,
					latest: {
						$type: 'string',
						...(aggregateId ? { $lt: latestKeyOf(`${streamName}-${aggregateId}`) } : {}),
					},
				},
				{ sort: { latest: -1 }, limit, projection: ENVELOPE_PROJECTION },
			)
			.map((entity) => toEnvelope<A>(entity));

		yield* batchCursor(cursor, batch);
	}

	/**
	 * The snapshot with the highest version of every stream that has one, in one query.
	 */
	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		streams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const result = new Map<SnapshotStream, SnapshotEnvelope<A>>();
		if (streams.length === 0) {
			return result;
		}
		const collection = SnapshotCollection.get(pool);
		const lasts = await this.snapshots(collection)
			.aggregate<{ _id: string; last: SnapshotDocument }>([
				{ $match: { streamId: { $in: [...new Set(streams.map(({ streamId }) => streamId))] } } },
				{ $sort: { streamId: 1, version: -1 } },
				{ $group: { _id: '$streamId', last: { $first: '$$ROOT' } } },
			])
			.toArray();
		const byStreamId = new Map(lasts.map(({ _id, last }) => [_id, last]));
		for (const stream of streams) {
			const last = byStreamId.get(stream.streamId);
			if (last) {
				result.set(stream, toEnvelope<A>(last));
			}
		}
		return result;
	}

	/**
	 * Migrates the 3.x snapshot collections of the store's database to schema v2 (ADR 0002 §6): drops `latest: null`,
	 * flags exactly the highest version of every stream, and replaces the 3.x latest index with the unique one.
	 * `dryRun: true` only reports.
	 */
	public async migrate(options: MongoDBMigrationOptions = {}): Promise<MigrationReport> {
		if (!this.client) {
			throw new Error('The MongoDB snapshot store is not connected: call connect() first');
		}
		return migrateSnapshotCollections(
			{ client: this.client, db: this.database, topology: this.topology, logger: this.logger },
			options,
		);
	}

	/**
	 * A replica set: reads the last snapshot, unflags the previous latest and inserts the new one, in one transaction.
	 */
	private async appendInTransaction(target: AppendTarget, entity: SnapshotDocument): Promise<'appended' | 'raced'> {
		if (!this.client) {
			throw new Error('The MongoDB snapshot store is not connected: call connect() first');
		}
		const session = this.client.startSession();
		try {
			session.startTransaction({
				readConcern: { level: 'snapshot' },
				writeConcern: { w: 'majority' },
				readPreference: 'primary',
			});
			await this.assertAfterLast(target, entity.version, session);
			await this.snapshots(target.collection).updateMany(
				{ streamId: target.stream.streamId, latest: { $exists: true }, version: { $lt: entity.version } },
				{ $unset: { latest: '' } },
				{ session },
			);
			await this.snapshots(target.collection).insertOne(entity, { session });
			await session.commitTransaction();
			return 'appended';
		} catch (error) {
			if (session.inTransaction()) {
				await session.abortTransaction().catch(() => undefined);
			}
			return this.classifyAppendError(error, target, entity.version);
		} finally {
			await session.endSession().catch(() => undefined);
		}
	}

	/**
	 * A standalone server: unflags the previous latest, inserts the new one, and flags the previous one again if the
	 * insert fails. The last snapshot is read by version, so a crash in between loses nothing.
	 */
	private async appendWithRepair(target: AppendTarget, entity: SnapshotDocument): Promise<'appended' | 'raced'> {
		const { collection, stream } = target;
		await this.assertAfterLast(target, entity.version);
		// Only a lower version is unflagged: a higher one flagged by a racing append keeps its flag, and this insert fails
		const unflagged = await this.snapshots(collection).findOneAndUpdate(
			{ streamId: stream.streamId, latest: { $type: 'string' }, version: { $lt: entity.version } },
			{ $unset: { latest: '' } },
			{ projection: { _id: 1 } },
		);
		try {
			await this.snapshots(collection).insertOne(entity);
			return 'appended';
		} catch (error) {
			if (unflagged) {
				await this.snapshots(collection)
					.updateOne(
						{ _id: unflagged._id, latest: { $exists: false } },
						{ $set: { latest: latestKeyOf(stream.streamId) } },
					)
					.catch(() => undefined);
			}
			return this.classifyAppendError(error, target, entity.version);
		}
	}

	/** Throws a version conflict unless the snapshot comes after the last snapshot of the stream. */
	private async assertAfterLast(
		{ collection, stream, pool }: AppendTarget,
		version: number,
		session?: ClientSession,
	): Promise<void> {
		const last = await this.snapshots(collection).findOne(
			{ streamId: stream.streamId },
			{ session, sort: { version: -1 }, projection: { _id: 0, version: 1 } },
		);
		if (last && version <= last.version) {
			throw new SnapshotStoreVersionConflictException({ stream, version, latestVersion: last.version, pool });
		}
	}

	/**
	 * A duplicate version is a conflict; a race on the latest flag (or a transient transaction error) is retried; every
	 * other error fails the append.
	 */
	private async classifyAppendError(
		error: unknown,
		{ collection, stream, pool }: AppendTarget,
		version: number,
	): Promise<'raced'> {
		if (error instanceof SnapshotStoreVersionConflictException) {
			throw error;
		}
		const key = duplicateKeyOf(error);
		if (key === 'stream-version' || key === 'id') {
			throw new SnapshotStoreVersionConflictException(
				{ stream, version, latestVersion: await this.latestVersion(collection, stream), pool },
				{ cause: error },
			);
		}
		if (key === 'latest' || hasErrorLabel(error, 'TransientTransactionError')) {
			return 'raced';
		}
		throw error;
	}

	/** Best-effort lookup of the latest snapshot version of a stream, used to report a conflict. */
	private async latestVersion(collection: ISnapshotCollection, stream: SnapshotStream): Promise<number | undefined> {
		try {
			return (
				await this.snapshots(collection).findOne(
					{ streamId: stream.streamId },
					{ sort: { version: -1 }, projection: { _id: 0, version: 1 } },
				)
			)?.version;
		} catch {
			return undefined;
		}
	}

	private async createCollection(collection: ISnapshotCollection): Promise<void> {
		try {
			await this.database.createCollection(collection);
		} catch (error) {
			if (!isNamespaceExistsError(error)) {
				throw error;
			}
		}
		await this.snapshots(collection).createIndexes([...SNAPSHOT_INDEXES]);
	}

	/**
	 * Rejects appends to collections that were never created (unknown pools).
	 * Collections that are known to exist are not looked up again, the server is only asked on a cache miss.
	 */
	private async assertCollectionExists(collection: ISnapshotCollection): Promise<void> {
		if (this.knownCollections.has(collection)) {
			return;
		}

		const collections = await this.database.listCollections({ name: collection }, { nameOnly: true }).toArray();

		if (collections.length === 0) {
			throw new Error(`Collection "${collection}" does not exist.`);
		}

		this.knownCollections.add(collection);
	}

	private catalog(): Collection<CatalogDocument> {
		return this.database.collection<CatalogDocument>(CATALOG_COLLECTION);
	}

	private snapshots(collection: ISnapshotCollection): Collection<SnapshotDocument> {
		return this.database.collection<SnapshotDocument>(collection);
	}
}

/** Where a snapshot is appended. */
interface AppendTarget {
	collection: ISnapshotCollection;
	stream: SnapshotStream;
	pool?: ISnapshotPool;
}

const latestKeyOf = (streamId: string): string => `latest#${streamId}`;

const toEnvelope = <A extends AggregateRoot>({
	payload,
	aggregateId,
	registeredOn,
	snapshotId,
	version,
}: Pick<
	SnapshotDocument,
	'payload' | 'aggregateId' | 'registeredOn' | 'snapshotId' | 'version'
>): SnapshotEnvelope<A> =>
	SnapshotEnvelope.from<A>(payload as ISnapshot<A>, { aggregateId, registeredOn, snapshotId, version });
