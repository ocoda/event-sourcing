import { randomUUID } from 'node:crypto';
import type { MigrationCollectionReport, MigrationReport } from '@ocoda/event-sourcing';
import type { Collection } from 'mongodb';
import type { MongoDBMigrationOptions } from '../interfaces/index.js';
import { CATALOG_COLLECTION, type CatalogDocument } from '../mongodb.schema.js';
import { isDuplicateKeyError } from '../mongodb.utils.js';
import type { MigrationContext } from './inspect.js';
import { LEASE_MS, type Lease, type MigrationEnvironment, leaseIdOf } from './plan.js';

/** How often a running migration renews its lease, in milliseconds. */
const LEASE_RENEWAL_MS = 60_000;

/**
 * @internal Crash injection for the migration specs: a hook that throws after a step stops the run there, like a crash.
 * Not exported from the package.
 */
export const migrationHooks: { onStepComplete?: (collection: string, step: string) => void | Promise<void> } = {};

/** A collection's migration, planned under the lease. */
export interface PlannedRun {
	report: MigrationCollectionReport;
	/** Runs a step (not the lease steps), reporting its progress. */
	runStep(step: string, progress: (done: number, total: number) => void): Promise<void>;
}

const catalogOf = (context: MigrationContext): Collection<CatalogDocument> =>
	context.db.collection<CatalogDocument>(CATALOG_COLLECTION);

/**
 * Leases a collection to this run: inserts the lease, or takes over one that expired (or any, with `force`). Returns
 * the lease that blocks the run otherwise.
 */
const takeLease = async (
	catalog: Collection<CatalogDocument>,
	collection: string,
	owner: string,
	force: boolean,
): Promise<true | Lease> => {
	const _id = leaseIdOf(collection);
	let current: Lease | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await catalog.insertOne({ _id, kind: 'lock', owner, expiresAt: new Date(Date.now() + LEASE_MS) });
			return true;
		} catch (error) {
			if (!isDuplicateKeyError(error)) {
				throw error;
			}
		}
		const found = await catalog.findOne({ _id, kind: 'lock' });
		if (found?.kind !== 'lock') {
			// Released in the meantime
			continue;
		}
		current = { owner: found.owner, expiresAt: found.expiresAt };
		if (!force && found.expiresAt > new Date()) {
			return current;
		}
		const { modifiedCount } = await catalog.updateOne(
			{ _id, owner: found.owner, expiresAt: found.expiresAt },
			{ $set: { owner, expiresAt: new Date(Date.now() + LEASE_MS) } },
		);
		if (modifiedCount === 1) {
			return true;
		}
	}
	return current ?? { owner: 'unknown', expiresAt: new Date(Date.now() + LEASE_MS) };
};

/**
 * Runs the migration of a collection under its lease: takes the lease, plans again (the collection may have changed
 * since the first look), runs the pending steps in order, and releases the lease, also when a step fails. A crash
 * leaves the lease until it expires; `force` takes it over sooner.
 */
export const runUnderLease = async (
	context: MigrationContext,
	collection: string,
	options: MongoDBMigrationOptions,
	firstLook: MigrationCollectionReport,
	plan: (owner: string) => Promise<PlannedRun>,
): Promise<MigrationCollectionReport> => {
	const catalog = catalogOf(context);
	const owner = randomUUID();
	const lease = await takeLease(catalog, collection, owner, options.force === true);
	if (lease !== true) {
		return {
			...firstLook,
			action: 'blocked',
			steps: firstLook.steps.map((step) => ({ ...step, status: 'skipped' })),
			blocking: [
				...firstLook.blocking,
				`another migration of this collection is running: its lease lasts until ${lease.expiresAt.toISOString()}. Wait for it, or pass force: true if that run was interrupted`,
			],
		};
	}

	const release = () => catalog.deleteOne({ _id: leaseIdOf(collection), owner });
	const renewal = setInterval(() => {
		catalog
			.updateOne({ _id: leaseIdOf(collection), owner }, { $set: { expiresAt: new Date(Date.now() + LEASE_MS) } })
			.catch((error) => context.logger.warn(`Could not renew the migration lease of ${collection}: ${String(error)}`));
	}, LEASE_RENEWAL_MS);
	renewal.unref();

	try {
		const { report, runStep } = await plan(owner);
		report.warnings = [...new Set([...firstLook.warnings, ...report.warnings])];
		if (report.action === 'skip' || report.action === 'blocked') {
			return report;
		}
		for (const step of report.steps) {
			if (step.status !== 'pending') {
				continue;
			}
			if (step.name === 'release') {
				await release();
			} else if (step.name !== 'lease') {
				context.logger.log(`Migrating ${collection}: ${step.name}`);
				await runStep(step.name, (done, total) => options.onProgress?.({ collection, step: step.name, done, total }));
			}
			step.status = 'done';
			options.onProgress?.({ collection, step: step.name });
			await migrationHooks.onStepComplete?.(collection, step.name);
		}
		return report;
	} finally {
		clearInterval(renewal);
		await release().catch(() => undefined);
	}
};

/** The report of a whole run. */
export const reportOf = (
	options: MongoDBMigrationOptions,
	environment: MigrationEnvironment,
	collections: MigrationCollectionReport[],
): MigrationReport => ({
	dryRun: options.dryRun === true,
	environment: {
		serverVersion: environment.serverVersion,
		topology: environment.topology,
		timeZones: { process: Intl.DateTimeFormat().resolvedOptions().timeZone },
	},
	collections,
});

/** The distinct collections of the given pools, in order. */
export const collectionsOf = <P>(pools: readonly P[], collectionOf: (pool: P) => string): string[] => [
	...new Set(pools.map(collectionOf)),
];
