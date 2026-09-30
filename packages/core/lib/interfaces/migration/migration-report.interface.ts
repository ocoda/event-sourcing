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
 * MariaDB: a stream whose rows the migration gives one stream id. The 3.x tables compared stream ids in their
 * collation, which usually ignores case, so one 3.x stream could hold rows whose ids differ in case only.
 */
export interface MigrationCanonicalizedStream {
	/**
	 * The stream id of every row of the stream after the migration: the id of its lowest version. A snapshot stream
	 * takes the id of its events instead, where the pool's 3.x events have the stream.
	 */
	streamId: string;
	/**
	 * The other stream ids that its rows had, which the migration replaces.
	 */
	variants: string[];
	/**
	 * The rows whose stream id the migration replaces.
	 */
	rows: number;
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
	 * MariaDB: 3.x streams whose rows have ids that differ in case only (or otherwise compare equal in the 3.x table's
	 * collation). The case-sensitive 4.0 schema would split them, so the migration gives each one stream id: see
	 * `canonicalizedStreams`.
	 */
	caseVariantStreams?: number;
	/**
	 * MariaDB: the streams whose rows the migration gives one stream id, with a sample of at most 1000. After the
	 * migration, the application must use those ids: the 4.0 schema compares stream ids in binary.
	 */
	canonicalizedStreams?: { total: number; rows: number; sample: MigrationCanonicalizedStream[] };
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
