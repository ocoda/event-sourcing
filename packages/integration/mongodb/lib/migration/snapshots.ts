import { type MigrationCollectionReport, type MigrationReport, SnapshotCollection } from '@ocoda/event-sourcing';
import type { Collection } from 'mongodb';
import type { MongoDBMigrationOptions } from '../interfaces/index.js';
import {
	CATALOG_COLLECTION,
	type CatalogDocument,
	type IndexInfo,
	SCHEMA_VERSION,
	SNAPSHOT_INDEXES,
} from '../mongodb.schema.js';
import { type MigrationContext, discoverCollections, inspectSnapshotCollection, readEnvironment } from './inspect.js';
import { type SnapshotStepName, latestRepairPipeline, legacyLatestIndexes, planSnapshotCollection } from './plan.js';
import { DEFAULT_LOCK_TIMEOUT_MS, collectionsOf, reportOf, runUnderLease, waitingForLock } from './runner.js';

/** The fields of a snapshot document the migration touches. */
type SnapshotFields = { _id: string; streamId: string; version: number; latest?: string | null };

/** Error codes of `createIndexes` for an index whose key another index has with other options. */
const INDEX_CONFLICTS = new Set([85, 86]);

/**
 * Migrates the snapshot collections of the store's database (ADR 0002 §6, MongoDB snapshots): per collection, inspect,
 * plan, and unless it's a dry run, run the pending steps under the collection's lease.
 */
export const migrateSnapshotCollections = async (
	context: MigrationContext,
	options: MongoDBMigrationOptions,
): Promise<MigrationReport> => {
	const environment = await readEnvironment(context);
	const names = options.pools
		? collectionsOf(options.pools, (pool) => SnapshotCollection.get(pool))
		: await discoverCollections(context.db, 'snapshots');

	const collections: MigrationCollectionReport[] = [];
	for (const name of names) {
		const firstLook = planSnapshotCollection(await inspectSnapshotCollection(context, name), environment, options);
		if (options.dryRun || firstLook.action === 'skip' || firstLook.action === 'blocked') {
			collections.push(firstLook);
			continue;
		}
		collections.push(
			await runUnderLease(context, name, options, firstLook, async (owner) => {
				const report = planSnapshotCollection(
					await inspectSnapshotCollection(context, name),
					{ ...environment, now: new Date() },
					{ ...options, owner },
				);
				return {
					report,
					runStep: (step) =>
						runSnapshotStep(context, name, step as SnapshotStepName, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS),
				};
			}),
		);
	}
	return reportOf(options, environment, collections);
};

const runSnapshotStep = async (
	{ db }: MigrationContext,
	name: string,
	step: SnapshotStepName,
	lockTimeoutMs: number,
): Promise<void> => {
	const collection = db.collection<SnapshotFields>(name);
	const latestUnique = SNAPSHOT_INDEXES[1];
	switch (step) {
		case 'unset-null-latest':
			await collection.updateMany({ latest: { $type: 'null' } }, { $unset: { latest: '' } });
			return;
		case 'repair-latest-flags': {
			// $group is blocking, so the updates don't change what the cursor reads. A 4.0 store may append snapshots
			// meanwhile (3.x snapshot collections keep working), so the highest version is read again right before the repair
			const cursor = collection.aggregate<{ _id: string }>(latestRepairPipeline(), { allowDiskUse: true });
			try {
				for await (const { _id: streamId } of cursor) {
					const top = await collection.findOne(
						{ streamId },
						{ sort: { version: -1 }, projection: { _id: 1, version: 1 } },
					);
					if (!top) {
						continue;
					}
					await collection.updateMany(
						{ streamId, version: { $lt: top.version }, latest: { $exists: true } },
						{ $unset: { latest: '' } },
					);
					await collection.updateOne({ _id: top._id }, { $set: { latest: `latest#${streamId}` } });
				}
			} finally {
				await cursor.close().catch(() => undefined);
			}
			return;
		}
		case 'index': {
			const create = () =>
				collection.createIndex(latestUnique.key, {
					unique: true,
					partialFilterExpression: latestUnique.partialFilterExpression,
					name: latestUnique.name,
				});
			try {
				await create();
			} catch (error) {
				// A server that doesn't allow two indexes on the same key: drop the 3.x one first
				if (!INDEX_CONFLICTS.has((error as { code?: number }).code ?? 0)) {
					throw error;
				}
				await dropLegacyLatestIndexes(collection, name, lockTimeoutMs);
				await create();
			}
			return;
		}
		case 'drop-latest-indexes':
			await dropLegacyLatestIndexes(collection, name, lockTimeoutMs);
			return;
		case 'register':
			await db
				.collection<CatalogDocument>(CATALOG_COLLECTION)
				.updateOne(
					{ _id: name },
					{ $setOnInsert: { kind: 'snapshots' }, $set: { schemaVersion: SCHEMA_VERSION } },
					{ upsert: true },
				);
			return;
	}
};

const dropLegacyLatestIndexes = async (collection: Collection<SnapshotFields>, name: string, lockTimeoutMs: number) => {
	for (const index of legacyLatestIndexes((await collection.listIndexes().toArray()) as IndexInfo[])) {
		await waitingForLock(name, lockTimeoutMs, () => collection.dropIndex(index, { maxTimeMS: lockTimeoutMs }));
	}
};
