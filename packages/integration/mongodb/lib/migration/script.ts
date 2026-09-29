import { CATALOG_COLLECTION, type IndexInfo, shellCollection, toShell } from '../mongodb.schema.js';
import {
	CANONICAL_EVENT_ID,
	EVENT_LOCKS,
	EVENT_STEPS,
	type EventStepName,
	SNAPSHOT_LOCKS,
	SNAPSHOT_STEPS,
	type SnapshotStepName,
	eventStepStatement,
	snapshotStepStatement,
} from './plan.js';

/** The indexes 3.0.0 to 3.0.2 create on an event collection. */
const V1_EVENT_INDEXES: readonly IndexInfo[] = [
	{ name: '_id_', key: { _id: 1 } },
	{ name: 'streamId_1_version_1', key: { streamId: 1, version: 1 }, unique: true },
	{ name: 'eventDate_1__id_1', key: { eventDate: 1, _id: 1 }, unique: true },
];

/** The indexes 3.0.0 to 3.0.2 create on a snapshot collection. */
const V1_SNAPSHOT_INDEXES: readonly IndexInfo[] = [
	{ name: '_id_', key: { _id: 1 } },
	{ name: 'streamId_1_version_1', key: { streamId: 1, version: 1 }, unique: true },
	{ name: 'aggregateName_1_latest_1', key: { aggregateName: 1, latest: 1 } },
];

const HEADER = `// @ocoda/event-sourcing-mongodb 4.0: migrates the collections of the default pools, \`events\` and \`snapshots\`, from the
// 3.x schema to schema v2 (ADR 0002 §6). Generated from lib/migration/plan.ts by \`pnpm gen:migration-sql\`; don't edit.
//
// MongoDBEventStore.migrate() and MongoDBSnapshotStore.migrate() do the same for every pool: they check the state
// before each step, skip what is done, resume an interrupted run and report. Prefer them. This script is for review,
// and for databases whose stores run with ddl: 'none'.
//
// 1. Take a backup, and make sure the oplog window and the disk have room (see the MongoDB integration guide).
// 2. Stop every 3.x instance.
// 3. Run it once, on the 3.x collections: mongosh "mongodb://<host>/<database of the stores>" 4.0.mongosh.js
// It first checks what migrate() checks before it writes (and stops there, changing nothing), then stops at the first
// error of a step. migrate() resumes a run that stopped once the script's lease expires (10 minutes after it was
// taken), or at once with force: true. After step "register" 4.0 can run.
`;

/**
 * The checks the planner blocks on, for the default pools: the script stops before its first write when one fails.
 * Sharding and privileges aren't checked here; a failing step stops the script.
 */
const PREFLIGHT = `// Preflight: what blocks migrate(), checked before anything is written
const events = ${shellCollection('events')};
const preflight = [
	Number(db.version().split('.')[0]) >= 5 || \`MongoDB \${db.version()} can't number the events on the server: MongoDB 5.0 or later is needed\`,
	db.getCollectionInfos({ name: 'events' }).length === 1 || 'there is no events collection',
	catalog.countDocuments({ _id: 'events', schemaVersion: 2 }) === 0 ||
		'events is registered with schema version 2 already: run migrate() for what is left',
	!db.getCollectionInfos({ name: 'events' })[0]?.options?.validator ||
		'events has a validator: a validator of your own (remove it), or a migration that stopped (run migrate(), which resumes it)',
	catalog.countDocuments({ _id: { $in: ['lock:migrate:events', 'lock:migrate:snapshots'] } }) === 0 ||
		'another migration holds a lease on events or snapshots: wait for it, or run migrate() with force: true if it was interrupted',
	events.getIndexes().some(({ key, unique }) => unique && JSON.stringify(key) === '{"streamId":1,"version":1}') ||
		'the unique { streamId: 1, version: 1 } index of events is missing; create it, then migrate',
	events.countDocuments({ _id: { $not: { $type: 'string' } } }) === 0 ||
		'events has event ids that are not strings; 3.x never wrote such events',
	canonicalIds ||
		events.countDocuments({ eventDate: { $not: { $type: 'string' } } }) === 0 ||
		'events has events without an eventDate string; 3.x never wrote such events',
].filter((check) => check !== true);
if (preflight.length > 0) {
	throw new Error(\`Nothing was migrated: \${preflight.join('; ')}\`);
}
`;

/** One statement of the script, with a comment naming its step and lock. */
const statementBlock = (collection: string, step: string, lock: string, statement: string): string =>
	`// ${collection}: ${step} (lock: ${lock})\n${statement};\n`;

const eventBlock = (step: EventStepName): string => {
	const statement = (numbering: 'id' | 'event-date') =>
		eventStepStatement('events', step, { numbering, indexes: V1_EVENT_INDEXES, owner: 'owner' });
	if (step !== 'number') {
		return statementBlock('events', step, EVENT_LOCKS[step], statement('id'));
	}
	return [
		`// events: ${step} (lock: ${EVENT_LOCKS[step]}), in 3.x's order and every stream in version order (ADR 0001 D33):`,
		'// by _id when every id is a canonical ULID (3.x derived eventDate from it), otherwise by (eventDate, _id)',
		'if (canonicalIds) {',
		`\t${statement('id')};`,
		'} else {',
		`\t${statement('event-date')};`,
		'}',
		'',
	].join('\n');
};

const snapshotBlock = (step: SnapshotStepName): string =>
	statementBlock(
		'snapshots',
		step,
		SNAPSHOT_LOCKS[step],
		snapshotStepStatement('snapshots', step, { indexes: V1_SNAPSHOT_INDEXES, owner: 'owner' }),
	);

/**
 * The mongosh script of `migrations/4.0.mongosh.js`: the migration of the default pools of a 3.0.x database, rendered
 * from the statements of the planner, so it can't drift from what `migrate()` runs.
 */
export const renderMigrationScript = (): string =>
	[
		HEADER,
		'const owner = `mongosh-${new Date().toISOString()}`;',
		`const catalog = ${shellCollection(CATALOG_COLLECTION)};`,
		`const canonicalIds = ${shellCollection('events')}.countDocuments({ _id: { $not: ${toShell(CANONICAL_EVENT_ID)} } }) === 0;`,
		'',
		PREFLIGHT,
		'// Events: fence 3.x writers off, number, index, register (the commit point), then clean up',
		...EVENT_STEPS.map(eventBlock),
		'// Snapshots: one latest flag per stream, on its highest version, enforced by a unique index',
		...SNAPSHOT_STEPS.map(snapshotBlock),
		"print(`Migrated events and snapshots; ${catalog.countDocuments({ _id: { $in: ['events', 'snapshots'] }, schemaVersion: 2 })} of 2 collections registered with schema version 2.`);",
		'',
	].join('\n');
