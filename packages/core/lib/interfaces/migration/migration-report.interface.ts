/**
 * A step of the migration of one collection.
 */
export interface MigrationStep {
	/**
	 * What the step does.
	 */
	name: string;
	/**
	 * The exact statement the step runs, so that it can be reviewed or run by hand.
	 */
	statement: string;
	/**
	 * The lock the step takes, such as `ACCESS EXCLUSIVE`.
	 */
	lock: string;
	status: 'pending' | 'done' | 'skipped';
}

/**
 * A stream whose versions don't run from 1 without gaps.
 */
export interface MigrationGappedStream {
	streamId: string;
	events: number;
	minVersion: number;
	maxVersion: number;
}

/**
 * What the migration found in, and did to, one collection.
 */
export interface MigrationCollectionReport {
	name: string;
	kind: 'events' | 'snapshots';
	/**
	 * The schema the collection had: none, the 3.x schema, a partly migrated 3.x schema or the 4.0 schema.
	 */
	from: 'absent' | 'v1' | 'v1-partial' | 'v2';
	/**
	 * What the migration does with the collection. A `blocked` collection is left untouched; see `blocking`.
	 */
	action: 'migrate' | 'resume' | 'skip' | 'blocked';
	rows: number;
	bytes?: number;
	/**
	 * Streams whose versions have gaps, with a sample of at most 1000.
	 */
	gappedStreams: { total: number; sample: MigrationGappedStream[] };
	duplicateEventIds?: number;
	/**
	 * Event ids that are not Crockford base32 ULIDs.
	 */
	nonCrockfordEventIds?: number;
	/**
	 * MariaDB: streams whose ids only differ in case, which the case-sensitive 4.0 schema splits.
	 */
	caseVariantStreams?: number;
	/**
	 * MariaDB: how the `occurred_on` values were restored from the event ids.
	 */
	occurredOnRepair?: { exact: number; precisionOnly: number; tzShifted: number; kept: number };
	/**
	 * Snapshot streams with more than one, or without a, latest snapshot.
	 */
	snapshotFlags?: { duplicateLatest: number; missingLatest: number };
	/**
	 * Objects that depend on the collection: PostgreSQL views, triggers and publications; MariaDB triggers and foreign
	 * keys.
	 */
	dependents?: string[];
	droppedIndexes?: string[];
	steps: MigrationStep[];
	warnings: string[];
	/**
	 * Why the collection can't be migrated. The migration writes nothing to a collection with blocking issues.
	 */
	blocking: string[];
}

/**
 * What a store's `migrate()` found and did.
 */
export interface MigrationReport {
	dryRun: boolean;
	environment: {
		serverVersion: string;
		topology?: string;
		timeZones: { process: string; server?: string; session?: string };
	};
	collections: MigrationCollectionReport[];
}
