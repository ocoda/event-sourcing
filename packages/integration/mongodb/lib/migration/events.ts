import {
	EventCollection,
	type MigrationCollectionReport,
	type MigrationReport,
	toPosition,
} from '@ocoda/event-sourcing';
import { type Collection, Long } from 'mongodb';
import type { MongoDBMigrationOptions } from '../interfaces/index.js';
import {
	CATALOG_COLLECTION,
	type CatalogDocument,
	EVENTS_VALIDATOR,
	type IndexInfo,
	SCHEMA_VERSION,
	VALIDATION_OPTIONS,
} from '../mongodb.schema.js';
import { type MigrationContext, discoverCollections, inspectEventCollection, readEnvironment } from './inspect.js';
import {
	type EventStepName,
	type NumberingKey,
	eventDateIndexes,
	numberingPipeline,
	planEventCollection,
} from './plan.js';
import { DEFAULT_LOCK_TIMEOUT_MS, collectionsOf, reportOf, runUnderLease, waitingForLock } from './runner.js';

/** The fields of an event document the migration touches. */
type EventFields = { _id: string; globalPosition?: Long | number | bigint; eventDate?: string };

/** The events whose `eventDate` one `updateMany` of the clean-up removes. */
const UNSET_BATCH = 10_000;

/** Error code of `dropIndexes` for an index that doesn't exist (`IndexNotFound`). */
const INDEX_NOT_FOUND = 27;

/**
 * Migrates the event collections of the store's database (ADR 0002 §6, MongoDB events): per collection, inspect, plan,
 * and unless it's a dry run, run the pending steps under the collection's lease.
 */
export const migrateEventCollections = async (
	context: MigrationContext,
	options: MongoDBMigrationOptions,
): Promise<MigrationReport> => {
	const environment = await readEnvironment(context);
	const names = options.pools
		? collectionsOf(options.pools, (pool) => EventCollection.get(pool))
		: await discoverCollections(context.db, 'events');

	const collections: MigrationCollectionReport[] = [];
	for (const name of names) {
		const firstLook = planEventCollection(await inspectEventCollection(context, name), environment, options);
		const { action } = firstLook.report;
		if (options.dryRun || action === 'skip' || action === 'blocked') {
			collections.push(firstLook.report);
			continue;
		}
		collections.push(
			await runUnderLease(context, name, options, firstLook.report, async (owner) => {
				const { report, numbering } = planEventCollection(
					await inspectEventCollection(context, name),
					{ ...environment, now: new Date() },
					{ ...options, owner },
				);
				return {
					report,
					runStep: (step, progress) =>
						runEventStep(
							context,
							name,
							step as EventStepName,
							{ numbering, rows: report.rows, lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS },
							progress,
						),
				};
			}),
		);
	}
	return reportOf(options, environment, collections);
};

const runEventStep = async (
	{ db }: MigrationContext,
	name: string,
	step: EventStepName,
	{ numbering, rows, lockTimeoutMs }: { numbering: NumberingKey; rows: number; lockTimeoutMs: number },
	progress: (done: number, total: number) => void,
): Promise<void> => {
	const collection = db.collection<EventFields>(name);
	switch (step) {
		case 'fence':
			// The exclusive lock of the collMod waits for the running operations on the collection, at most lockTimeoutMs
			await waitingForLock(name, lockTimeoutMs, () =>
				db.command({ collMod: name, validator: EVENTS_VALIDATOR, ...VALIDATION_OPTIONS, maxTimeMS: lockTimeoutMs }),
			);
			return;
		case 'number':
			progress(0, rows);
			await collection.aggregate(numberingPipeline(name, numbering), { allowDiskUse: true }).toArray();
			progress(rows, rows);
			return;
		case 'index':
			await collection.createIndex({ globalPosition: 1 }, { unique: true });
			return;
		case 'register': {
			const [highest] = await collection
				.find({}, { projection: { _id: 0, globalPosition: 1 }, sort: { globalPosition: -1 }, limit: 1 })
				.toArray();
			const lastPosition = highest?.globalPosition === undefined ? 0n : toPosition(highest.globalPosition);
			await db.collection<CatalogDocument>(CATALOG_COLLECTION).updateOne(
				{ _id: name },
				{
					$setOnInsert: { kind: 'events' },
					$set: { schemaVersion: SCHEMA_VERSION },
					$max: { lastPosition: Long.fromBigInt(lastPosition) },
				},
				{ upsert: true },
			);
			return;
		}
		case 'drop-event-date-indexes':
			for (const index of eventDateIndexes((await collection.listIndexes().toArray()) as IndexInfo[])) {
				await waitingForLock(name, lockTimeoutMs, () =>
					collection.dropIndex(index, { maxTimeMS: lockTimeoutMs }),
				).catch((error) => {
					if ((error as { code?: unknown }).code !== INDEX_NOT_FOUND) {
						throw error;
					}
				});
			}
			return;
		case 'unset-event-date':
			await unsetEventDate(collection, rows, progress);
			return;
	}
};

/**
 * Removes `eventDate` in batches along the `_id` index, so a run can be interrupted and resumed, and reports progress.
 */
const unsetEventDate = async (
	collection: Collection<EventFields>,
	total: number,
	progress: (done: number, total: number) => void,
): Promise<void> => {
	let after: string | undefined;
	let done = 0;
	for (;;) {
		const range = after === undefined ? {} : { $gt: after };
		const ids = await collection
			.find(after === undefined ? {} : { _id: range }, { projection: { _id: 1 }, sort: { _id: 1 }, limit: UNSET_BATCH })
			.toArray();
		if (ids.length === 0) {
			return;
		}
		const last = ids[ids.length - 1]._id;
		await collection.updateMany(
			{ _id: { ...range, $lte: last }, eventDate: { $exists: true } },
			{ $unset: { eventDate: '' } },
		);
		done += ids.length;
		progress(done, total);
		after = last;
	}
};
