import type { Logger } from '@nestjs/common';
import type { MigrationGappedStream } from '@ocoda/event-sourcing';
import type { Collection, Db, Document, MongoClient } from 'mongodb';
import {
	CATALOG_COLLECTION,
	type CatalogDocument,
	classifyValidator,
	hasLatestUniqueIndex,
	hasUniqueIndex,
	readCollectionShape,
	SCHEMA_VERSION,
} from '../mongodb.schema.js';
import type { MongoDBTopology } from '../mongodb.topology.js';
import {
	CANONICAL_EVENT_ID,
	type EventCollectionInspection,
	type Lease,
	type MigrationEnvironment,
	type SnapshotCollectionInspection,
	latestRepairPipeline,
	leaseIdOf,
} from './plan.js';

/** What a migration runs with. */
export interface MigrationContext {
	client: MongoClient;
	db: Db;
	topology: MongoDBTopology;
	logger: Logger;
}

/** The size of the sample of gapped streams in a report. */
const GAPPED_SAMPLE_SIZE = 1000;

export const readEnvironment = async ({ client, topology }: MigrationContext): Promise<MigrationEnvironment> => {
	const info = await client.db('admin').command({ buildInfo: 1 });
	const serverVersion = String(info.version);
	const serverMajor = Array.isArray(info.versionArray)
		? Number(info.versionArray[0])
		: Number.parseInt(serverVersion, 10);
	return { serverVersion, serverMajor, topology, now: new Date() };
};

/**
 * The collections of a kind in the database, by name (`events` / `<pool>-events`, `snapshots` / `<pool>-snapshots`, as
 * 3.x named them) and shape (the unique `{ streamId: 1, version: 1 }` index every 3.x and 4.0 collection has).
 */
export const discoverCollections = async (db: Db, kind: 'events' | 'snapshots'): Promise<string[]> => {
	const names = (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray())
		.map(({ name }) => name)
		.filter((name) => (name === kind || name.endsWith(`-${kind}`)) && !name.startsWith('system.'))
		.sort();
	const shaped: string[] = [];
	for (const name of names) {
		const { indexes } = await readCollectionShape(db, name);
		if (hasUniqueIndex(indexes, { streamId: 1, version: 1 })) {
			shaped.push(name);
		}
	}
	return shaped;
};

const readLease = async (db: Db, name: string): Promise<Lease | undefined> => {
	const lease = await db
		.collection<CatalogDocument>(CATALOG_COLLECTION)
		.findOne({ _id: leaseIdOf(name), kind: 'lock' });
	return lease?.kind === 'lock' ? { owner: lease.owner, expiresAt: lease.expiresAt } : undefined;
};

const readRegistration = async (
	db: Db,
	name: string,
	kind: 'events' | 'snapshots',
): Promise<{ schemaVersion: number } | undefined> => {
	const registered = await db.collection<CatalogDocument>(CATALOG_COLLECTION).findOne({ _id: name, kind });
	return registered ? { schemaVersion: Number((registered as { schemaVersion: unknown }).schemaVersion) } : undefined;
};

/** The storage and index size of a collection, if the user may read them. */
const readBytes = async (collection: Collection): Promise<number | undefined> => {
	try {
		const [stats] = await collection.aggregate<Document>([{ $collStats: { storageStats: {} } }]).toArray();
		const storage = stats?.storageStats as { storageSize?: number; totalIndexSize?: number } | undefined;
		return storage ? Number(storage.storageSize ?? 0) + Number(storage.totalIndexSize ?? 0) : undefined;
	} catch {
		return undefined;
	}
};

/** Whether a collection is sharded, on a `mongos`. */
const readSharded = async ({ client, db, topology }: MigrationContext, name: string): Promise<boolean> => {
	if (topology !== 'sharded') {
		return false;
	}
	const entry = await client
		.db('config')
		.collection('collections')
		.findOne({ _id: `${db.databaseName}.${name}` as never });
	return Boolean(entry && !entry.dropped && !entry.unsplittable);
};

/**
 * The streams whose versions don't run from 1 without gaps, from one streaming pass over the `{ streamId, version }`
 * index (covered: no document is fetched), with the count, minimum and maximum per stream computed here.
 */
const scanStreams = async (
	collection: Collection,
	indexed: boolean,
): Promise<{ total: number; sample: MigrationGappedStream[] }> => {
	const cursor = collection.find(
		{},
		{
			projection: { _id: 0, streamId: 1, version: 1 },
			sort: { streamId: 1, version: 1 },
			...(indexed ? { hint: { streamId: 1, version: 1 } } : { allowDiskUse: true }),
			batchSize: 10_000,
		},
	);
	let total = 0;
	const sample: MigrationGappedStream[] = [];
	let current: MigrationGappedStream | undefined;
	const flush = () => {
		if (current && (current.minVersion !== 1 || current.maxVersion !== current.events)) {
			total++;
			if (sample.length < GAPPED_SAMPLE_SIZE) {
				sample.push(current);
			}
		}
	};
	try {
		for await (const { streamId, version } of cursor) {
			let stream = current;
			if (!stream || stream.streamId !== streamId) {
				flush();
				stream = { streamId, events: 0, minVersion: Number(version), maxVersion: Number(version) };
				current = stream;
			}
			stream.events++;
			stream.maxVersion = Number(version);
		}
		flush();
	} finally {
		await cursor.close().catch(() => undefined);
	}
	return { total, sample };
};

export const inspectEventCollection = async (
	context: MigrationContext,
	name: string,
): Promise<EventCollectionInspection> => {
	const { db } = context;
	const [shape, registered, lease] = await Promise.all([
		readCollectionShape(db, name),
		readRegistration(db, name, 'events'),
		readLease(db, name),
	]);
	const inspection: EventCollectionInspection = {
		name,
		exists: shape.exists,
		registered,
		validator: classifyValidator(shape.validator),
		indexes: shape.indexes,
		rows: 0,
		unpositioned: 0,
		eventDateLeft: false,
		nonStringIds: 0,
		nonCanonicalIds: 0,
		withoutEventDate: 0,
		gappedStreams: { total: 0, sample: [] },
		sharded: false,
		lease,
	};
	if (!shape.exists) {
		return inspection;
	}

	const collection = db.collection(name);
	inspection.rows = await collection.countDocuments({});
	inspection.bytes = await readBytes(collection);
	inspection.sharded = await readSharded(context, name);
	inspection.eventDateLeft =
		(await collection.findOne({ eventDate: { $exists: true } }, { projection: { _id: 1 } })) !== null;
	if (registered?.schemaVersion === SCHEMA_VERSION) {
		// Migrated or created by 4.0: only the clean-up after the commit point can be left
		return inspection;
	}

	inspection.unpositioned = await collection.countDocuments({ globalPosition: { $exists: false } });
	inspection.nonStringIds = await collection.countDocuments({ _id: { $not: { $type: 'string' } } });
	inspection.nonCanonicalIds = await collection.countDocuments({ _id: { $not: CANONICAL_EVENT_ID } });
	if (inspection.nonCanonicalIds > 0) {
		inspection.withoutEventDate = await collection.countDocuments({ eventDate: { $not: { $type: 'string' } } });
	}
	inspection.gappedStreams = await scanStreams(collection, hasUniqueIndex(shape.indexes, { streamId: 1, version: 1 }));
	return inspection;
};

export const inspectSnapshotCollection = async (
	context: MigrationContext,
	name: string,
): Promise<SnapshotCollectionInspection> => {
	const { db } = context;
	const [shape, registered, lease] = await Promise.all([
		readCollectionShape(db, name),
		readRegistration(db, name, 'snapshots'),
		readLease(db, name),
	]);
	const inspection: SnapshotCollectionInspection = {
		name,
		exists: shape.exists,
		registered,
		indexes: shape.indexes,
		rows: 0,
		nullLatest: 0,
		duplicateLatest: 0,
		missingLatest: 0,
		misflagged: 0,
		sharded: false,
		lease,
	};
	if (!shape.exists) {
		return inspection;
	}

	const collection = db.collection(name);
	inspection.rows = await collection.countDocuments({});
	inspection.bytes = await readBytes(collection);
	inspection.sharded = await readSharded(context, name);
	inspection.nullLatest = await collection.countDocuments({ latest: { $type: 'null' } });
	if (registered?.schemaVersion === SCHEMA_VERSION && hasLatestUniqueIndex(shape.indexes)) {
		// The unique index keeps one flag per stream
		return inspection;
	}

	const [flags] = await collection
		.aggregate<{ duplicate: number; missing: number; misflagged: number }>(
			[
				...latestRepairPipeline(),
				{
					$group: {
						_id: null,
						duplicate: { $sum: { $cond: [{ $gt: ['$flags', 1] }, 1, 0] } },
						missing: { $sum: { $cond: [{ $eq: ['$flags', 0] }, 1, 0] } },
						misflagged: { $sum: { $cond: [{ $eq: ['$flags', 1] }, 1, 0] } },
					},
				},
			],
			{ allowDiskUse: true },
		)
		.toArray();
	inspection.duplicateLatest = flags?.duplicate ?? 0;
	inspection.missingLatest = flags?.missing ?? 0;
	inspection.misflagged = flags?.misflagged ?? 0;
	return inspection;
};
