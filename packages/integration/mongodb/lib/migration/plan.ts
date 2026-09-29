import type { MigrationCollectionReport, MigrationGappedStream, MigrationStep } from '@ocoda/event-sourcing';
import { Long } from 'mongodb';
import type { Document } from 'mongodb';
import {
	CATALOG_COLLECTION,
	EVENTS_VALIDATOR,
	type IndexInfo,
	LATEST_UNIQUE_INDEX,
	SCHEMA_VERSION,
	SNAPSHOT_INDEXES,
	VALIDATION_OPTIONS,
	findIndex,
	hasLatestUniqueIndex,
	hasUniqueIndex,
	shellCollection,
	toShell,
} from '../mongodb.schema.js';
import type { MongoDBTopology } from '../mongodb.topology.js';

// The pure half of migrate(): what a collection needs, from what inspect.ts found. No I/O, so every state is covered by
// table-driven specs, and the committed migration script (script.ts) is rendered from the same statements.

/** An event id as 4.0 generates it: a ULID in upper-case Crockford base32. */
export const CANONICAL_EVENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** How long a migration lease lasts without being renewed, in milliseconds. */
export const LEASE_MS = 10 * 60_000;

/** The number of versions a stream can have (`version` is a 32-bit integer), which spaces the numbering keys. */
const VERSION_SPAN = Long.fromNumber(2 ** 31);

/** The catalog document that leases a collection to a running migration. */
export const leaseIdOf = (collection: string): string => `lock:migrate:${collection}`;

/** A migration lease, as the catalog holds it. */
export interface Lease {
	owner: string;
	expiresAt: Date;
}

/** A privilege as `connectionStatus` with `showPrivileges` reports it. */
export interface Privilege {
	resource: { db?: string; collection?: string; anyResource?: boolean; cluster?: boolean };
	actions: string[];
}

/** The server a migration runs against. */
export interface MigrationEnvironment {
	serverVersion: string;
	serverMajor: number;
	topology: MongoDBTopology;
	now: Date;
	/** The database of the stores. */
	database: string;
	/**
	 * The privileges of the authenticated users; `undefined` when nobody is authenticated (a server without access
	 * control), so there is nothing to check.
	 */
	privileges?: Privilege[];
}

/**
 * The actions a migration needs on the collection it migrates (the numbering's `$merge` inserts and updates), and on
 * the catalog (registration and lease).
 */
export const MIGRATION_ACTIONS = {
	events: ['find', 'insert', 'update', 'collMod', 'createIndex', 'dropIndex', 'listIndexes'],
	snapshots: ['find', 'update', 'createIndex', 'dropIndex', 'listIndexes'],
	catalog: ['find', 'insert', 'update', 'remove'],
} as const;

const covers = (resource: Privilege['resource'], database: string, collection: string): boolean =>
	resource.anyResource === true ||
	((resource.db === '' || resource.db === database) &&
		(resource.collection === '' ? !collection.startsWith('system.') : resource.collection === collection));

/**
 * The actions of `actions` that no privilege grants on `<database>.<collection>`. Nothing is missing when the
 * privileges are unknown (`undefined`: no access control).
 */
export const missingActions = (
	privileges: readonly Privilege[] | undefined,
	database: string,
	collection: string,
	actions: readonly string[],
): string[] =>
	privileges === undefined
		? []
		: actions.filter(
				(action) =>
					!privileges.some(
						({ resource, actions: granted }) => granted.includes(action) && covers(resource, database, collection),
					),
			);

/** Why the privileges block the migration of a collection, if they do. */
const privilegeBlock = (
	environment: MigrationEnvironment,
	collection: string,
	actions: readonly string[],
): string | undefined => {
	const missing = [
		...missingActions(environment.privileges, environment.database, collection, actions).map(
			(action) => `${action} on ${environment.database}.${collection}`,
		),
		...missingActions(environment.privileges, environment.database, CATALOG_COLLECTION, MIGRATION_ACTIONS.catalog).map(
			(action) => `${action} on ${environment.database}.${CATALOG_COLLECTION}`,
		),
	];
	return missing.length > 0
		? `the user lacks privileges the migration needs: ${missing.join(', ')} (the dbAdmin and readWrite roles on the database grant them)`
		: undefined;
};

/** What `migrate()` found in an event collection. */
export interface EventCollectionInspection {
	name: string;
	exists: boolean;
	/** The catalog document of the collection: set once the collection was created or migrated with schema v2. */
	registered?: { schemaVersion: number };
	/** No validator, the 4.0 validator, or another one. */
	validator: 'none' | 'v2' | 'other';
	indexes: IndexInfo[];
	rows: number;
	bytes?: number;
	/** Events without a `globalPosition`. */
	unpositioned: number;
	/** Whether any event still has the 3.x `eventDate` field. */
	eventDateLeft: boolean;
	nonStringIds: number;
	/** Event ids that aren't canonical ULIDs (lower case, or not Crockford base32), including non-string ones. */
	nonCanonicalIds: number;
	/** Events without an `eventDate` string, counted only when there are non-canonical ids. */
	withoutEventDate: number;
	gappedStreams: { total: number; sample: MigrationGappedStream[] };
	sharded: boolean;
	lease?: Lease;
}

/** What `migrate()` found in a snapshot collection. */
export interface SnapshotCollectionInspection {
	name: string;
	exists: boolean;
	registered?: { schemaVersion: number };
	indexes: IndexInfo[];
	rows: number;
	bytes?: number;
	/** Snapshots with `latest: null`, which 3.x wrote when it unflagged a snapshot. */
	nullLatest: number;
	/** Streams with more than one flagged snapshot. */
	duplicateLatest: number;
	/** Streams without a flagged snapshot. */
	missingLatest: number;
	/** Streams with one flagged snapshot that isn't the one with the highest version. */
	misflagged: number;
	sharded: boolean;
	lease?: Lease;
}

export interface PlanOptions {
	/** Take over a lease that hasn't expired. */
	force?: boolean;
	/** Remove `eventDate` after the commit point (default true). */
	unsetEventDate?: boolean;
	/** The owner of the lease this run holds, if it holds one. */
	owner?: string;
}

/**
 * How the events are ranked in 3.x's order `(eventDate, _id)`: by `_id` alone when every id is a canonical ULID (3.x
 * derived `eventDate` from the id, so the orders are equal, and the `_id` index gives the order), otherwise by the
 * concatenated key.
 */
export type NumberingKey = 'id' | 'event-date';

export interface EventPlan {
	report: MigrationCollectionReport;
	numbering: NumberingKey;
}

/** The names of the steps of an event collection's migration, in order. */
export const EVENT_STEPS = [
	'lease',
	'fence',
	'number',
	'index',
	'register',
	'drop-event-date-indexes',
	'unset-event-date',
	'release',
] as const;
export type EventStepName = (typeof EVENT_STEPS)[number];

/** The names of the steps of a snapshot collection's migration, in order. */
export const SNAPSHOT_STEPS = [
	'lease',
	'unset-null-latest',
	'repair-latest-flags',
	'index',
	'drop-latest-indexes',
	'register',
	'release',
] as const;
export type SnapshotStepName = (typeof SNAPSHOT_STEPS)[number];

/**
 * The server-side numbering (ADR 0001 D33, ADR 0002 §6): `r` is the rank in 3.x's order, `k` the running maximum of
 * `r` over the stream in version order, and the position is the rank of `(k, version)`. So every stream stays in
 * version order, and where it already was, the order is 3.x's. `$documentNumber` takes one sort key, so `(k, version)`
 * is one 64-bit key, and it returns a 32-bit integer, which `$toLong` widens for the validator.
 */
export const numberingPipeline = (collection: string, key: NumberingKey): Document[] => [
	...(key === 'id'
		? [
				{ $setWindowFields: { sortBy: { _id: 1 }, output: { r: { $documentNumber: {} } } } },
				{ $project: { _id: 1, streamId: 1, version: 1, r: 1 } },
			]
		: [
				{ $project: { _id: 1, streamId: 1, version: 1, rankKey: { $concat: ['$eventDate', '#', '$_id'] } } },
				{ $setWindowFields: { sortBy: { rankKey: 1 }, output: { r: { $documentNumber: {} } } } },
			]),
	{
		$setWindowFields: {
			partitionBy: '$streamId',
			sortBy: { version: 1 },
			output: { k: { $max: '$r', window: { documents: ['unbounded', 'current'] } } },
		},
	},
	{ $set: { orderKey: { $add: [{ $multiply: [{ $toLong: '$k' }, VERSION_SPAN] }, '$version'] } } },
	{ $setWindowFields: { sortBy: { orderKey: 1 }, output: { position: { $documentNumber: {} } } } },
	{ $project: { _id: 1, globalPosition: { $toLong: '$position' } } },
	{ $merge: { into: collection, on: '_id', whenMatched: 'merge', whenNotMatched: 'fail' } },
];

/** The keys of the indexes that contain `eventDate`: 3.x's `{ eventDate: 1, _id: 1 }` and any other. */
export const eventDateIndexes = (indexes: readonly IndexInfo[]): string[] =>
	indexes.filter(({ key }) => Object.hasOwn(key, 'eventDate')).map(({ name }) => name);

/** The 3.x index on the latest flag, which the unique one replaces. */
export const legacyLatestIndexes = (indexes: readonly IndexInfo[]): string[] =>
	indexes
		.filter(
			(index) =>
				index.name !== LATEST_UNIQUE_INDEX &&
				index.partialFilterExpression === undefined &&
				findIndex([index], { aggregateName: 1, latest: 1 }) !== undefined,
		)
		.map(({ name }) => name);

const leaseStatement = (collection: string): string =>
	`${shellCollection(CATALOG_COLLECTION)}.insertOne({ _id: ${toShell(leaseIdOf(collection))}, kind: 'lock', owner: <owner>, expiresAt: new Date(Date.now() + ${LEASE_MS}) })`;

const releaseStatement = (collection: string): string =>
	`${shellCollection(CATALOG_COLLECTION)}.deleteOne({ _id: ${toShell(leaseIdOf(collection))}, owner: <owner> })`;

/** The last position after the numbering: the highest one, which is the number of events. */
const lastPositionExpression = (collection: string): string =>
	`${shellCollection(collection)}.find({}, { globalPosition: 1 }).sort({ globalPosition: -1 }).limit(1).next()?.globalPosition ?? NumberLong(0)`;

/** The mongosh statement of a step of an event collection's migration. */
export const eventStepStatement = (
	collection: string,
	step: EventStepName,
	context: { numbering: NumberingKey; indexes: readonly IndexInfo[] },
): string => {
	const coll = shellCollection(collection);
	switch (step) {
		case 'lease':
			return leaseStatement(collection);
		case 'fence':
			return `db.runCommand(${toShell({ collMod: collection, validator: EVENTS_VALIDATOR, ...VALIDATION_OPTIONS })})`;
		case 'number':
			return `${coll}.aggregate(${toShell(numberingPipeline(collection, context.numbering))}, { allowDiskUse: true })`;
		case 'index':
			return `${coll}.createIndex({ globalPosition: 1 }, { unique: true })`;
		case 'register':
			return `${shellCollection(CATALOG_COLLECTION)}.updateOne(${toShell({ _id: collection })}, { $setOnInsert: { kind: 'events' }, $set: { schemaVersion: ${SCHEMA_VERSION} }, $max: { lastPosition: ${lastPositionExpression(collection)} } }, { upsert: true })`;
		case 'drop-event-date-indexes': {
			const names = eventDateIndexes(context.indexes);
			return (names.length > 0 ? names : ['eventDate_1__id_1'])
				.map((name) => `${coll}.dropIndex(${toShell(name)})`)
				.join('; ');
		}
		case 'unset-event-date':
			return `${coll}.updateMany({ eventDate: { $exists: true } }, { $unset: { eventDate: '' } })`;
		case 'release':
			return releaseStatement(collection);
	}
};

/** The mongosh statement of a step of a snapshot collection's migration. */
export const snapshotStepStatement = (
	collection: string,
	step: SnapshotStepName,
	context: { indexes: readonly IndexInfo[] },
): string => {
	const coll = shellCollection(collection);
	switch (step) {
		case 'lease':
			return leaseStatement(collection);
		case 'unset-null-latest':
			return `${coll}.updateMany({ latest: { $type: 'null' } }, { $unset: { latest: '' } })`;
		case 'repair-latest-flags':
			return `${coll}.aggregate(${toShell(latestRepairPipeline())}, { allowDiskUse: true }).forEach(({ _id, top }) => { ${coll}.updateMany({ streamId: _id, _id: { $ne: top }, latest: { $exists: true } }, { $unset: { latest: '' } }); ${coll}.updateOne({ _id: top }, { $set: { latest: 'latest#' + _id } }); })`;
		case 'index':
			return `${coll}.createIndex(${toShell(SNAPSHOT_INDEXES[1].key)}, ${toShell({ unique: true, partialFilterExpression: SNAPSHOT_INDEXES[1].partialFilterExpression, name: LATEST_UNIQUE_INDEX })})`;
		case 'drop-latest-indexes': {
			const names = legacyLatestIndexes(context.indexes);
			return (names.length > 0 ? names : ['aggregateName_1_latest_1'])
				.map((name) => `${coll}.dropIndex(${toShell(name)})`)
				.join('; ');
		}
		case 'register':
			return `${shellCollection(CATALOG_COLLECTION)}.updateOne(${toShell({ _id: collection })}, ${toShell({ $setOnInsert: { kind: 'snapshots' }, $set: { schemaVersion: SCHEMA_VERSION } })}, { upsert: true })`;
		case 'release':
			return releaseStatement(collection);
	}
};

/**
 * The streams whose latest flag needs repair: several flags, none, or one that isn't on the highest version. Yields
 * `{ _id: streamId, top: <the _id of the snapshot with the highest version> }`.
 */
export const latestRepairPipeline = (): Document[] => [
	{ $sort: { streamId: 1, version: -1 } },
	{
		$group: {
			_id: '$streamId',
			top: { $first: '$_id' },
			topFlag: { $first: '$latest' },
			flags: { $sum: { $cond: [{ $eq: [{ $type: '$latest' }, 'string'] }, 1, 0] } },
		},
	},
	{ $match: { $expr: { $or: [{ $ne: ['$flags', 1] }, { $ne: [{ $type: '$topFlag' }, 'string'] }] } } },
	{ $project: { _id: 1, top: 1, flags: 1 } },
];

const EVENT_LOCKS: Record<EventStepName, string> = {
	lease: 'none',
	fence: 'exclusive collection lock for the collMod (milliseconds)',
	number: 'intent locks: reads and writes go on',
	index: 'exclusive collection lock at the start and the end of the index build',
	register: 'none',
	'drop-event-date-indexes': 'exclusive collection lock (milliseconds)',
	'unset-event-date': 'intent locks: reads and writes go on',
	release: 'none',
};

const SNAPSHOT_LOCKS: Record<SnapshotStepName, string> = {
	lease: 'none',
	'unset-null-latest': 'intent locks: reads and writes go on',
	'repair-latest-flags': 'intent locks: reads and writes go on',
	index: 'exclusive collection lock at the start and the end of the index build',
	'drop-latest-indexes': 'exclusive collection lock (milliseconds)',
	register: 'none',
	release: 'none',
};

/** Why a lease blocks this run: held by another run that hasn't expired, and not forced. */
const leaseBlock = (lease: Lease | undefined, options: PlanOptions, now: Date): string | undefined => {
	if (!lease || lease.owner === options.owner || lease.expiresAt <= now || options.force) {
		return undefined;
	}
	return `another migration of this collection is running: its lease lasts until ${lease.expiresAt.toISOString()}. Wait for it, or pass force: true if that run was interrupted`;
};

const leaseWarning = (lease: Lease | undefined, options: PlanOptions, now: Date): string[] =>
	lease && lease.owner !== options.owner
		? [
				lease.expiresAt <= now
					? `the lease of an earlier run expired at ${lease.expiresAt.toISOString()} and is taken over`
					: `the lease of another run (until ${lease.expiresAt.toISOString()}) is taken over (force: true)`,
			]
		: [];

const steps = <S extends string>(
	names: readonly S[],
	pending: (name: S) => boolean,
	statement: (name: S) => string,
	locks: Record<S, string>,
	blocked: boolean,
): MigrationStep[] =>
	names.map((name) => ({
		name,
		statement: statement(name),
		lock: locks[name],
		status: !blocked && pending(name) ? 'pending' : 'skipped',
	}));

/** Marks the lease steps pending exactly when another step is. */
const withLease = (list: MigrationStep[]): MigrationStep[] => {
	const work = list.some(({ name, status }) => name !== 'lease' && name !== 'release' && status === 'pending');
	return list.map((step) =>
		step.name === 'lease' || step.name === 'release' ? { ...step, status: work ? 'pending' : 'skipped' } : step,
	);
};

const actionOf = (
	from: MigrationCollectionReport['from'],
	blocking: readonly string[],
	list: readonly MigrationStep[],
): MigrationCollectionReport['action'] => {
	if (blocking.length > 0) return 'blocked';
	if (!list.some(({ status }) => status === 'pending')) return 'skip';
	return from === 'v1' ? 'migrate' : 'resume';
};

/**
 * Plans the migration of an event collection (ADR 0002 §6): its state, the steps that are still to do, with their
 * statements, and what blocks it or deserves a warning. A step whose postcondition holds is skipped, so a second run
 * skips everything and a run after an interruption resumes.
 */
export const planEventCollection = (
	inspection: EventCollectionInspection,
	environment: MigrationEnvironment,
	options: PlanOptions = {},
): EventPlan => {
	const { name } = inspection;
	const numbering: NumberingKey = inspection.nonCanonicalIds > 0 ? 'event-date' : 'id';
	const base = {
		name,
		kind: 'events' as const,
		rows: inspection.rows,
		...(inspection.bytes === undefined ? {} : { bytes: inspection.bytes }),
		gappedStreams: inspection.gappedStreams,
		nonCrockfordEventIds: inspection.nonCanonicalIds,
	};

	if (!inspection.exists) {
		return {
			numbering,
			report: { ...base, from: 'absent', action: 'skip', steps: [], warnings: [], blocking: [] },
		};
	}

	const registered = inspection.registered?.schemaVersion === SCHEMA_VERSION;
	const from: MigrationCollectionReport['from'] = registered
		? 'v2'
		: inspection.validator !== 'v2' && !findIndex(inspection.indexes, { globalPosition: 1 })
			? 'v1'
			: 'v1-partial';

	const blocking: string[] = [];
	const warnings: string[] = [...leaseWarning(inspection.lease, options, environment.now)];
	if (!registered) {
		if (environment.serverMajor < 5) {
			blocking.push(
				`MongoDB ${environment.serverVersion} can't number the events on the server: MongoDB 5.0 or later is needed`,
			);
		}
		if (inspection.sharded) {
			blocking.push('the collection is sharded: migrating sharded event collections is not supported');
		}
		if (inspection.nonStringIds > 0) {
			blocking.push(
				`${inspection.nonStringIds} event(s) have an _id that is not a string; 3.x never wrote such events`,
			);
		}
		if (numbering === 'event-date' && inspection.withoutEventDate > 0) {
			blocking.push(`${inspection.withoutEventDate} event(s) have no eventDate string; 3.x never wrote such events`);
		}
		if (inspection.validator === 'other') {
			blocking.push('the collection has a validator of its own; remove it, then migrate');
		}
		if (!hasUniqueIndex(inspection.indexes, { streamId: 1, version: 1 })) {
			blocking.push('the unique { streamId: 1, version: 1 } index is missing; create it, then migrate');
		}
	}
	const privileges = privilegeBlock(environment, name, MIGRATION_ACTIONS.events);
	if (privileges && (!registered || inspection.eventDateLeft || eventDateIndexes(inspection.indexes).length > 0)) {
		blocking.push(privileges);
	}
	const leaseBlocking = leaseBlock(inspection.lease, options, environment.now);
	if (leaseBlocking) {
		blocking.push(leaseBlocking);
	}

	if (inspection.gappedStreams.total > 0) {
		warnings.push(
			`${inspection.gappedStreams.total} stream(s) have gaps in their versions: their next append in 4.0 conflicts. Load them with loadFromEnvelopes, or append with the actual version as the expected version`,
		);
	}
	if (numbering === 'event-date' && !registered) {
		warnings.push(
			`${inspection.nonCanonicalIds} event id(s) are not canonical ULIDs, so the events are numbered by (eventDate, _id) instead of _id, which sorts on disk`,
		);
	}
	const droppedIndexes = eventDateIndexes(inspection.indexes);
	const unsetEventDate = options.unsetEventDate !== false;
	if (!unsetEventDate && inspection.eventDateLeft) {
		warnings.push('eventDate is kept (unsetEventDate: false): a later migrate() removes it');
	}

	const pending = (step: EventStepName): boolean => {
		switch (step) {
			case 'fence':
				return !registered && inspection.validator !== 'v2';
			case 'number':
				return !registered && (from === 'v1' ? inspection.rows > 0 : inspection.unpositioned > 0);
			case 'index':
				return !hasUniqueIndex(inspection.indexes, { globalPosition: 1 });
			case 'register':
				return !registered;
			case 'drop-event-date-indexes':
				return droppedIndexes.length > 0;
			case 'unset-event-date':
				return unsetEventDate && inspection.eventDateLeft;
			default:
				return false;
		}
	};
	const list = withLease(
		steps(
			EVENT_STEPS,
			pending,
			(step) => eventStepStatement(name, step, { numbering, indexes: inspection.indexes }),
			EVENT_LOCKS,
			blocking.length > 0,
		),
	);

	return {
		numbering,
		report: {
			...base,
			from,
			action: actionOf(from, blocking, list),
			droppedIndexes,
			steps: list,
			warnings,
			blocking,
		},
	};
};

/**
 * Plans the migration of a snapshot collection (ADR 0002 §6): drop `latest: null`, flag exactly the highest version of
 * every stream, create the unique latest index, drop the 3.x one, register.
 */
export const planSnapshotCollection = (
	inspection: SnapshotCollectionInspection,
	environment: MigrationEnvironment,
	options: PlanOptions = {},
): MigrationCollectionReport => {
	const { name } = inspection;
	const base = {
		name,
		kind: 'snapshots' as const,
		rows: inspection.rows,
		...(inspection.bytes === undefined ? {} : { bytes: inspection.bytes }),
		gappedStreams: { total: 0, sample: [] },
		snapshotFlags: { duplicateLatest: inspection.duplicateLatest, missingLatest: inspection.missingLatest },
	};
	if (!inspection.exists) {
		return { ...base, from: 'absent', action: 'skip', steps: [], warnings: [], blocking: [] };
	}

	const registered = inspection.registered?.schemaVersion === SCHEMA_VERSION;
	const unique = hasLatestUniqueIndex(inspection.indexes);
	const from: MigrationCollectionReport['from'] = registered ? 'v2' : unique ? 'v1-partial' : 'v1';

	const blocking: string[] = [];
	if (inspection.sharded && !registered) {
		blocking.push('the collection is sharded: migrating sharded snapshot collections is not supported');
	}
	const privileges = privilegeBlock(environment, name, MIGRATION_ACTIONS.snapshots);
	if (privileges && !(registered && unique)) {
		blocking.push(privileges);
	}
	const leaseBlocking = leaseBlock(inspection.lease, options, environment.now);
	if (leaseBlocking) {
		blocking.push(leaseBlocking);
	}
	const warnings = [...leaseWarning(inspection.lease, options, environment.now)];
	if (inspection.misflagged > 0) {
		warnings.push(
			`${inspection.misflagged} stream(s) flag a snapshot that is not their highest version as the latest; the highest version is flagged instead`,
		);
	}
	const dropped = legacyLatestIndexes(inspection.indexes);

	const pending = (step: SnapshotStepName): boolean => {
		switch (step) {
			case 'unset-null-latest':
				return inspection.nullLatest > 0;
			case 'repair-latest-flags':
				return inspection.duplicateLatest + inspection.missingLatest + inspection.misflagged > 0;
			case 'index':
				return !unique;
			case 'drop-latest-indexes':
				return dropped.length > 0;
			case 'register':
				return !registered;
			default:
				return false;
		}
	};
	const list = withLease(
		steps(
			SNAPSHOT_STEPS,
			pending,
			(step) => snapshotStepStatement(name, step, { indexes: inspection.indexes }),
			SNAPSHOT_LOCKS,
			blocking.length > 0,
		),
	);

	return {
		...base,
		from,
		action: actionOf(from, blocking, list),
		droppedIndexes: dropped,
		steps: list,
		warnings,
		blocking,
	};
};
