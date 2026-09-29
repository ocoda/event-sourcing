import { Long } from 'mongodb';
import {
	type EventCollectionInspection,
	type MigrationEnvironment,
	type Privilege,
	type SnapshotCollectionInspection,
	eventDateIndexes,
	legacyLatestIndexes,
	missingActions,
	numberingPipeline,
	planEventCollection,
	planSnapshotCollection,
} from '../../lib/migration/plan.js';
import {
	type IndexInfo,
	classifyValidator,
	eventCollectionDdl,
	EVENTS_VALIDATOR,
	registrationStatement,
	snapshotCollectionDdl,
	toShell,
} from '../../lib/mongodb.schema.js';
import { duplicateKeyOf, hasErrorLabel, isNamespaceExistsError } from '../../lib/mongodb.utils.js';

// The pure half of migrate() (lib/migration/plan.ts): every state of a collection, what blocks it, and the statements
// of its steps. No database.

const NOW = new Date('2026-09-29T12:00:00.000Z');
const ENVIRONMENT: MigrationEnvironment = {
	serverVersion: '8.0.4',
	serverMajor: 8,
	topology: 'replica-set',
	now: NOW,
	database: 'es',
};

const ID_INDEX: IndexInfo = { name: '_id_', key: { _id: 1 } };
const STREAM_INDEX: IndexInfo = { name: 'streamId_1_version_1', key: { streamId: 1, version: 1 }, unique: true };
const EVENT_DATE_INDEX: IndexInfo = { name: 'eventDate_1__id_1', key: { eventDate: 1, _id: 1 }, unique: true };
const POSITION_INDEX: IndexInfo = { name: 'globalPosition_1', key: { globalPosition: 1 }, unique: true };
const LEGACY_LATEST_INDEX: IndexInfo = { name: 'aggregateName_1_latest_1', key: { aggregateName: 1, latest: 1 } };
const LATEST_UNIQUE_INDEX: IndexInfo = {
	name: 'latest_unique',
	key: { aggregateName: 1, latest: 1 },
	unique: true,
	partialFilterExpression: { latest: { $type: 'string' } },
};

/** An event collection as 3.x left it. */
const v1Events = (overrides: Partial<EventCollectionInspection> = {}): EventCollectionInspection => ({
	name: 'events',
	exists: true,
	validator: 'none',
	indexes: [ID_INDEX, STREAM_INDEX, EVENT_DATE_INDEX],
	rows: 10,
	bytes: 4096,
	unpositioned: 10,
	eventDateLeft: true,
	nonStringIds: 0,
	nonCanonicalIds: 0,
	withoutEventDate: 0,
	gappedStreams: { total: 0, sample: [] },
	sharded: false,
	...overrides,
});

/** A snapshot collection as 3.x left it. */
const v1Snapshots = (overrides: Partial<SnapshotCollectionInspection> = {}): SnapshotCollectionInspection => ({
	name: 'snapshots',
	exists: true,
	indexes: [ID_INDEX, STREAM_INDEX, LEGACY_LATEST_INDEX],
	rows: 9,
	nullLatest: 3,
	duplicateLatest: 1,
	missingLatest: 1,
	misflagged: 1,
	sharded: false,
	...overrides,
});

const pendingOf = (steps: { name: string; status: string }[]) =>
	steps.filter(({ status }) => status === 'pending').map(({ name }) => name);

describe('planEventCollection', () => {
	const numbered = { validator: 'v2' as const, unpositioned: 0 };
	const indexed = { ...numbered, indexes: [ID_INDEX, STREAM_INDEX, EVENT_DATE_INDEX, POSITION_INDEX] };
	const registered = { ...indexed, registered: { schemaVersion: 2 } };

	it.each([
		['a missing collection', { exists: false }, 'absent', 'skip', []],
		[
			'a 3.x collection',
			{},
			'v1',
			'migrate',
			['lease', 'fence', 'number', 'index', 'register', 'drop-event-date-indexes', 'unset-event-date', 'release'],
		],
		[
			// Numbered all the same: a 3.x writer may insert between this look and the fence
			'an empty 3.x collection',
			{ rows: 0, unpositioned: 0, eventDateLeft: false },
			'v1',
			'migrate',
			['lease', 'fence', 'number', 'index', 'register', 'drop-event-date-indexes', 'release'],
		],
		[
			'a fenced collection',
			{ validator: 'v2' as const },
			'v1-partial',
			'resume',
			['lease', 'number', 'index', 'register', 'drop-event-date-indexes', 'unset-event-date', 'release'],
		],
		[
			'a numbered collection',
			numbered,
			'v1-partial',
			'resume',
			['lease', 'index', 'register', 'drop-event-date-indexes', 'unset-event-date', 'release'],
		],
		[
			'a numbered collection whose fence was undone',
			{ ...indexed, validator: 'none' as const },
			'v1-partial',
			'resume',
			['lease', 'fence', 'register', 'drop-event-date-indexes', 'unset-event-date', 'release'],
		],
		[
			'an indexed collection',
			indexed,
			'v1-partial',
			'resume',
			['lease', 'register', 'drop-event-date-indexes', 'unset-event-date', 'release'],
		],
		[
			'a registered collection before its clean-up',
			registered,
			'v2',
			'resume',
			['lease', 'drop-event-date-indexes', 'unset-event-date', 'release'],
		],
		[
			'a registered collection whose indexes are clean',
			{ ...registered, indexes: [ID_INDEX, STREAM_INDEX, POSITION_INDEX] },
			'v2',
			'resume',
			['lease', 'unset-event-date', 'release'],
		],
		[
			'a migrated collection',
			{ ...registered, indexes: [ID_INDEX, STREAM_INDEX, POSITION_INDEX], eventDateLeft: false },
			'v2',
			'skip',
			[],
		],
	])('plans %s', (_, overrides, from, action, pending) => {
		const { report } = planEventCollection(v1Events(overrides), ENVIRONMENT);

		expect(report).toMatchObject({ name: 'events', kind: 'events', from, action, blocking: [] });
		expect(pendingOf(report.steps)).toEqual(pending);
	});

	it('reports the collection with its statements, locks and the indexes it drops', () => {
		const { report, numbering } = planEventCollection(
			v1Events({ gappedStreams: { total: 1, sample: [{ streamId: 's', events: 2, minVersion: 1, maxVersion: 3 }] } }),
			ENVIRONMENT,
		);

		expect(numbering).toBe('id');
		expect(report).toMatchObject({ rows: 10, bytes: 4096, nonCrockfordEventIds: 0 });
		expect(report.droppedIndexes).toEqual(['eventDate_1__id_1']);
		expect(report.warnings).toEqual([expect.stringContaining('1 stream(s) have gaps')]);
		const statement = (name: string) => report.steps.find((step) => step.name === name)?.statement;
		expect(statement('lease')).toBe(
			"db.getCollection('event_sourcing_collections').insertOne({ _id: 'lock:migrate:events', kind: 'lock', owner: '<owner>', expiresAt: new Date(Date.now() + 600000) })",
		);
		expect(statement('fence')).toBe(
			"db.runCommand({ collMod: 'events', validator: { $jsonSchema: { bsonType: 'object', required: ['globalPosition', 'streamId', 'version'], properties: { globalPosition: { bsonType: 'long' } } } }, validationLevel: 'strict', validationAction: 'error' })",
		);
		expect(statement('number')).toContain(
			'{ $setWindowFields: { sortBy: { _id: 1 }, output: { r: { $documentNumber: {} } } } }',
		);
		expect(statement('number')).toContain(
			"{ $merge: { into: 'events', on: '_id', whenMatched: 'merge', whenNotMatched: 'fail' } }",
		);
		expect(statement('index')).toBe("db.getCollection('events').createIndex({ globalPosition: 1 }, { unique: true })");
		expect(statement('register')).toContain('$max: { lastPosition: db.getCollection(');
		expect(statement('drop-event-date-indexes')).toBe("db.getCollection('events').dropIndex('eventDate_1__id_1')");
		expect(statement('unset-event-date')).toBe(
			"db.getCollection('events').updateMany({ eventDate: { $exists: true } }, { $unset: { eventDate: '' } })",
		);
		expect(statement('release')).toContain("deleteOne({ _id: 'lock:migrate:events', owner: '<owner>' })");
		expect(report.steps.find(({ name }) => name === 'fence')?.lock).toContain('exclusive');
		expect(report.steps.find(({ name }) => name === 'number')?.lock).toContain('intent');
	});

	it('names the owner of the run in the lease statements, as a string', () => {
		const { report } = planEventCollection(v1Events(), ENVIRONMENT, { owner: "run-'1'" });
		const statement = (name: string) => report.steps.find((step) => step.name === name)?.statement;

		expect(statement('lease')).toContain("owner: 'run-\\'1\\''");
		expect(statement('release')).toContain("owner: 'run-\\'1\\''");
		expect(planSnapshotCollection(v1Snapshots(), ENVIRONMENT, { owner: 'run-2' }).steps[0].statement).toContain(
			"owner: 'run-2'",
		);
	});

	it('numbers by (eventDate, _id) when an id is not a canonical ULID, and warns', () => {
		const { report, numbering } = planEventCollection(v1Events({ nonCanonicalIds: 2 }), ENVIRONMENT);

		expect(numbering).toBe('event-date');
		expect(report.nonCrockfordEventIds).toBe(2);
		expect(report.steps.find(({ name }) => name === 'number')?.statement).toContain(
			"$concat: ['$eventDate', '#', '$_id']",
		);
		expect(report.warnings).toEqual([expect.stringContaining('2 event id(s) are not canonical ULIDs')]);
	});

	it('names every index on eventDate, and the 3.x name when it finds none', () => {
		const own = { name: 'by_date', key: { eventDate: -1 } };
		const { report } = planEventCollection(
			v1Events({ indexes: [ID_INDEX, STREAM_INDEX, EVENT_DATE_INDEX, own] }),
			ENVIRONMENT,
		);
		expect(report.droppedIndexes).toEqual(['eventDate_1__id_1', 'by_date']);
		expect(report.steps.find(({ name }) => name === 'drop-event-date-indexes')?.statement).toBe(
			"db.getCollection('events').dropIndex('eventDate_1__id_1'); db.getCollection('events').dropIndex('by_date')",
		);

		const bare = planEventCollection(v1Events({ indexes: [ID_INDEX, STREAM_INDEX] }), ENVIRONMENT).report;
		expect(bare.droppedIndexes).toEqual([]);
		expect(pendingOf(bare.steps)).not.toContain('drop-event-date-indexes');
		expect(bare.steps.find(({ name }) => name === 'drop-event-date-indexes')?.statement).toContain(
			"dropIndex('eventDate_1__id_1')",
		);
	});

	it('defers the removal of eventDate with unsetEventDate: false', () => {
		const { report } = planEventCollection(v1Events(registered), ENVIRONMENT, { unsetEventDate: false });

		expect(pendingOf(report.steps)).toEqual(['lease', 'drop-event-date-indexes', 'release']);
		expect(report.warnings).toContainEqual(expect.stringContaining('eventDate is kept'));
	});

	it.each([
		['a server older than 5.0', {}, { serverVersion: '4.4.29', serverMajor: 4 }, 'MongoDB 5.0 or later'],
		['a sharded collection', { sharded: true }, {}, 'sharded'],
		[
			'a collection that may be sharded (config.collections is not readable)',
			{ sharded: 'unknown' as const },
			{},
			'grant it find on config.collections',
		],
		['ids that are not strings', { nonStringIds: 3 }, {}, '3 event(s) have an _id that is not a string'],
		[
			'non-canonical ids without an eventDate',
			{ nonCanonicalIds: 1, withoutEventDate: 2 },
			{},
			'2 event(s) have no eventDate string',
		],
		['a validator of its own', { validator: 'other' as const }, {}, 'validator of its own'],
		['no unique { streamId, version } index', { indexes: [ID_INDEX, EVENT_DATE_INDEX] }, {}, 'index is missing'],
		[
			'missing privileges',
			{},
			{ privileges: [{ resource: { db: 'es', collection: '' }, actions: ['find', 'insert', 'update', 'remove'] }] },
			'collMod on es.events',
		],
	])('blocks %s, and plans no step', (_, overrides, environment, reason) => {
		const { report } = planEventCollection(v1Events(overrides), { ...ENVIRONMENT, ...environment });

		expect(report.action).toBe('blocked');
		expect(report.blocking).toEqual([expect.stringContaining(reason)]);
		expect(pendingOf(report.steps)).toEqual([]);
	});

	it('needs the privileges of the steps that are left', () => {
		const catalog = {
			resource: { db: 'es', collection: 'event_sourcing_collections' },
			actions: ['find', 'insert', 'update', 'remove'],
		};
		// Enough for the clean-up after the commit point, not for the numbering
		const cleanUp = {
			resource: { db: 'es', collection: 'events' },
			actions: ['find', 'listIndexes', 'update', 'dropIndex'],
		};
		const environment = { ...ENVIRONMENT, privileges: [catalog, cleanUp] };

		expect(planEventCollection(v1Events(registered), environment).report).toMatchObject({
			action: 'resume',
			blocking: [],
		});
		expect(planEventCollection(v1Events(), environment).report.blocking).toEqual([
			expect.stringContaining('collMod on es.events, insert on es.events, createIndex on es.events'),
		]);
		// Nothing left to do needs nothing
		const migrated = { ...registered, indexes: [ID_INDEX, STREAM_INDEX, POSITION_INDEX], eventDateLeft: false };
		expect(planEventCollection(v1Events(migrated), { ...ENVIRONMENT, privileges: [] }).report).toMatchObject({
			action: 'skip',
			blocking: [],
		});
	});

	it('does not block non-canonical ids that all have an eventDate, nor canonical ids without one', () => {
		expect(planEventCollection(v1Events({ nonCanonicalIds: 1 }), ENVIRONMENT).report.blocking).toEqual([]);
		expect(planEventCollection(v1Events({ withoutEventDate: 4 }), ENVIRONMENT).report.blocking).toEqual([]);
	});

	it('checks the 3.x conditions only until the collection is registered', () => {
		const { report } = planEventCollection(
			v1Events({ ...registered, sharded: true, nonStringIds: 1, validator: 'other' }),
			{ ...ENVIRONMENT, serverMajor: 4 },
		);
		expect(report).toMatchObject({ from: 'v2', action: 'resume', blocking: [] });
	});

	describe('the lease of another run', () => {
		const lease = (expiresAt: Date, owner = 'another-run') => ({ lease: { owner, expiresAt } });
		const later = new Date(NOW.getTime() + 60_000);
		const earlier = new Date(NOW.getTime() - 1);

		it('blocks while it lasts', () => {
			const { report } = planEventCollection(v1Events(lease(later)), ENVIRONMENT);
			expect(report).toMatchObject({ action: 'blocked', blocking: [expect.stringContaining(later.toISOString())] });
		});

		it.each([
			['once it expired', lease(earlier), {}, 'expired'],
			['with force', lease(later), { force: true }, 'taken over (force: true)'],
		])('is taken over %s, with a warning', (_, overrides, options, warning) => {
			const { report } = planEventCollection(v1Events(overrides), ENVIRONMENT, options);
			expect(report).toMatchObject({ action: 'migrate', blocking: [] });
			expect(report.warnings).toContainEqual(expect.stringContaining(warning));
		});

		it('is no obstacle to the run that holds it', () => {
			const { report } = planEventCollection(v1Events(lease(later, 'me')), ENVIRONMENT, { owner: 'me' });
			expect(report).toMatchObject({ action: 'migrate', blocking: [], warnings: [] });
		});
	});
});

describe('planSnapshotCollection', () => {
	it.each([
		['a missing collection', { exists: false }, 'absent', 'skip', []],
		[
			'a 3.x collection with damaged flags',
			{},
			'v1',
			'migrate',
			['lease', 'unset-null-latest', 'repair-latest-flags', 'index', 'drop-latest-indexes', 'register', 'release'],
		],
		[
			'a healthy 3.x collection',
			{ nullLatest: 0, duplicateLatest: 0, missingLatest: 0, misflagged: 0 },
			'v1',
			'migrate',
			['lease', 'index', 'drop-latest-indexes', 'register', 'release'],
		],
		[
			'a collection with the unique index',
			{
				nullLatest: 0,
				duplicateLatest: 0,
				missingLatest: 0,
				misflagged: 0,
				indexes: [ID_INDEX, STREAM_INDEX, LEGACY_LATEST_INDEX, LATEST_UNIQUE_INDEX],
			},
			'v1-partial',
			'resume',
			['lease', 'drop-latest-indexes', 'register', 'release'],
		],
		[
			'a collection registered with schema version 1',
			{ registered: { schemaVersion: 1 }, nullLatest: 0, duplicateLatest: 0, missingLatest: 0, misflagged: 0 },
			'v1',
			'migrate',
			['lease', 'index', 'drop-latest-indexes', 'register', 'release'],
		],
		[
			'a migrated collection',
			{
				registered: { schemaVersion: 2 },
				nullLatest: 0,
				duplicateLatest: 0,
				missingLatest: 0,
				misflagged: 0,
				indexes: [ID_INDEX, STREAM_INDEX, LATEST_UNIQUE_INDEX],
			},
			'v2',
			'skip',
			[],
		],
	])('plans %s', (_, overrides, from, action, pending) => {
		const report = planSnapshotCollection(v1Snapshots(overrides), ENVIRONMENT);

		expect(report).toMatchObject({ name: 'snapshots', kind: 'snapshots', from, action, blocking: [] });
		expect(pendingOf(report.steps)).toEqual(pending);
	});

	it('reports the damaged flags and the statements that repair them', () => {
		const report = planSnapshotCollection(v1Snapshots(), ENVIRONMENT);

		expect(report).toMatchObject({
			rows: 9,
			snapshotFlags: { duplicateLatest: 1, missingLatest: 1 },
			droppedIndexes: ['aggregateName_1_latest_1'],
			gappedStreams: { total: 0, sample: [] },
			warnings: [expect.stringContaining('1 stream(s) flag a snapshot that is not their highest version')],
		});
		const statement = (name: string) => report.steps.find((step) => step.name === name)?.statement;
		expect(statement('unset-null-latest')).toBe(
			"db.getCollection('snapshots').updateMany({ latest: { $type: 'null' } }, { $unset: { latest: '' } })",
		);
		// The highest version is read again at the repair: only the versions below it lose their flag
		expect(statement('repair-latest-flags')).toContain(
			".forEach(({ _id }) => { const top = db.getCollection('snapshots').find({ streamId: _id }, { _id: 1, version: 1 }).sort({ version: -1 }).limit(1).next();",
		);
		expect(statement('repair-latest-flags')).toContain(
			"updateMany({ streamId: _id, version: { $lt: top.version }, latest: { $exists: true } }, { $unset: { latest: '' } })",
		);
		expect(statement('repair-latest-flags')).toContain(
			"updateOne({ _id: top._id }, { $set: { latest: 'latest#' + _id } })",
		);
		expect(statement('index')).toBe(
			"db.getCollection('snapshots').createIndex({ aggregateName: 1, latest: 1 }, { unique: true, partialFilterExpression: { latest: { $type: 'string' } }, name: 'latest_unique' })",
		);
		expect(statement('drop-latest-indexes')).toBe(
			"db.getCollection('snapshots').dropIndex('aggregateName_1_latest_1')",
		);
		expect(statement('register')).toBe(
			"db.getCollection('event_sourcing_collections').updateOne({ _id: 'snapshots' }, { $setOnInsert: { kind: 'snapshots' }, $set: { schemaVersion: 2 } }, { upsert: true })",
		);
	});

	it.each([
		['a sharded collection', { sharded: true }, {}, 'sharded'],
		['a collection that may be sharded', { sharded: 'unknown' as const }, {}, 'config.collections'],
		[
			'another run',
			{ lease: { owner: 'another-run', expiresAt: new Date(NOW.getTime() + 1000) } },
			{},
			'another migration',
		],
		[
			'missing privileges',
			{},
			{ privileges: [{ resource: { db: 'es', collection: 'snapshots' }, actions: ['find', 'update'] }] },
			'createIndex on es.snapshots',
		],
	])('blocks %s', (_, overrides, environment, reason) => {
		const report = planSnapshotCollection(v1Snapshots(overrides), { ...ENVIRONMENT, ...environment });
		expect(report.action).toBe('blocked');
		expect(report.blocking).toEqual([expect.stringContaining(reason)]);
		expect(pendingOf(report.steps)).toEqual([]);
	});
});

describe('missingActions', () => {
	const privileges: Privilege[] = [
		{ resource: { db: 'es', collection: 'events' }, actions: ['find', 'collMod'] },
		{ resource: { db: 'es', collection: '' }, actions: ['insert'] },
		{ resource: { db: '', collection: '' }, actions: ['update'] },
		{ resource: { cluster: true }, actions: ['remove'] },
	];

	it.each([
		['unknown privileges (no access control)', undefined, 'events', ['find', 'dropIndex'], []],
		['one collection', privileges, 'events', ['find', 'collMod'], []],
		['every collection of the database', privileges, 'tenant-events', ['insert', 'find'], ['find']],
		['every database', privileges, 'events', ['update', 'remove'], ['remove']],
		['no system collection by a wildcard', privileges, 'system.views', ['insert', 'update'], ['insert', 'update']],
		['any resource', [{ resource: { anyResource: true }, actions: ['remove'] }], 'events', ['remove'], []],
	])('reads %s', (_, granted, collection, actions, missing) => {
		expect(missingActions(granted, 'es', collection, actions)).toEqual(missing);
	});

	it('only applies the privileges of the database', () => {
		expect(missingActions(privileges, 'other', 'events', ['find', 'update'])).toEqual(['find']);
	});
});

describe('numberingPipeline', () => {
	it.each([
		['id', { $setWindowFields: { sortBy: { _id: 1 }, output: { r: { $documentNumber: {} } } } }],
		[
			'event-date',
			{ $project: { _id: 1, streamId: 1, version: 1, rankKey: { $concat: ['$eventDate', '#', '$_id'] } } },
		],
	] as const)('ranks by %s, then keeps every stream in version order and writes 64-bit positions', (key, first) => {
		const pipeline = numberingPipeline('events', key);

		expect(pipeline[0]).toEqual(first);
		expect(pipeline).toContainEqual({
			$setWindowFields: {
				partitionBy: '$streamId',
				sortBy: { version: 1 },
				output: { k: { $max: '$r', window: { documents: ['unbounded', 'current'] } } },
			},
		});
		// (k, version) as one 64-bit key: both terms converted, so a version stored as a double can't round it
		expect(pipeline).toContainEqual({
			$set: {
				orderKey: {
					$add: [{ $multiply: [{ $toLong: '$k' }, Long.fromNumber(2 ** 31)] }, { $toLong: '$version' }],
				},
			},
		});
		expect(pipeline.at(-2)).toEqual({ $project: { _id: 1, globalPosition: { $toLong: '$position' } } });
		expect(pipeline.at(-1)).toEqual({
			$merge: { into: 'events', on: '_id', whenMatched: 'merge', whenNotMatched: 'fail' },
		});
	});
});

describe('indexes', () => {
	it('finds the indexes on eventDate, and the 3.x latest indexes', () => {
		expect(eventDateIndexes([ID_INDEX, STREAM_INDEX, EVENT_DATE_INDEX, POSITION_INDEX])).toEqual(['eventDate_1__id_1']);
		expect(legacyLatestIndexes([ID_INDEX, LEGACY_LATEST_INDEX, LATEST_UNIQUE_INDEX])).toEqual([
			'aggregateName_1_latest_1',
		]);
		expect(
			legacyLatestIndexes([{ name: 'own', key: { aggregateName: 1, latest: 1 }, partialFilterExpression: { a: 1 } }]),
		).toEqual([]);
	});
});

describe('schema helpers', () => {
	it.each([
		[null, 'null'],
		[undefined, 'undefined'],
		["it's a \\ path\nnext", "'it\\'s a \\\\ path\\nnext'"],
		[42, '42'],
		[true, 'true'],
		[12n, "NumberLong('12')"],
		[Long.fromString('9007199254740993'), "NumberLong('9007199254740993')"],
		[new Date('2021-01-01T00:00:00.000Z'), "ISODate('2021-01-01T00:00:00.000Z')"],
		[/^a$/i, '/^a$/i'],
		[[1, 'a'], "[1, 'a']"],
		[{}, '{}'],
		[{ 'my-key': 1, $set: { a: [] } }, "{ 'my-key': 1, $set: { a: [] } }"],
	])('renders %s as a mongosh literal', (value, rendered) => {
		expect(toShell(value)).toBe(rendered);
	});

	it('renders the statements of a new collection and its registration', () => {
		expect(eventCollectionDdl('tenant-events')).toEqual([
			expect.stringMatching(/^db\.createCollection\('tenant-events', \{ validator: \{ \$jsonSchema:/),
			"db.getCollection('tenant-events').createIndexes([{ key: { streamId: 1, version: 1 }, unique: true }, { key: { globalPosition: 1 }, unique: true }])",
			"db.getCollection('event_sourcing_collections').updateOne({ _id: 'tenant-events' }, { $setOnInsert: { kind: 'events' }, $set: { schemaVersion: 2 }, $max: { lastPosition: NumberLong('0') } }, { upsert: true })",
		]);
		expect(snapshotCollectionDdl('snapshots')[0]).toBe("db.createCollection('snapshots')");
		expect(registrationStatement('snapshots', 'snapshots', 1)).not.toContain('lastPosition');
	});

	it('tells the 4.0 validator from others', () => {
		expect(classifyValidator(undefined)).toBe('none');
		expect(classifyValidator(EVENTS_VALIDATOR)).toBe('v2');
		expect(classifyValidator({ version: { $gte: 1 } })).toBe('other');
	});
});

describe('driver errors', () => {
	it.each([
		['a key pattern', { code: 11000, keyPattern: { streamId: 1, version: 1 } }, 'stream-version'],
		[
			'a bulk write message',
			{ code: 11000, writeErrors: [{ code: 11000, errmsg: 'E11000 dup key: { _id: "01H" }' }] },
			'id',
		],
		['a message', { code: 11000, message: 'E11000 duplicate key error dup key: { globalPosition: 7 }' }, 'position'],
		[
			'values with commas and colons',
			{ code: 11000, errmsg: 'dup key: { aggregateName: "a, b: c", latest: "latest#x: y" }' },
			'latest',
		],
		[
			'the index of a bulk write, whose values may hold quotes and newlines',
			{
				code: 11000,
				errmsg:
					'E11000 duplicate key error collection: es.a-events index: streamId_1_version_1 dup key: { streamId: "a"b, c: d", version: 1 }',
			},
			'stream-version',
		],
		[
			'a stream id with a newline',
			{
				code: 11000,
				writeErrors: [
					{
						code: 11000,
						errmsg:
							'E11000 duplicate key error collection: es.events index: streamId_1_version_1 dup key: { streamId: "a\nb", version: 1 }',
					},
				],
			},
			'stream-version',
		],
		['the _id index', { code: 11000, errmsg: 'E11000 index: _id_ dup key: { _id: "a, b: c" }' }, 'id'],
		[
			'the position index',
			{ code: 11000, errmsg: 'E11000 index: globalPosition_1 dup key: { globalPosition: 7 }' },
			'position',
		],
		[
			'the latest flag index',
			{ code: 11000, errmsg: 'E11000 index: latest_unique dup key: { aggregateName: "a", latest: "b" }' },
			'latest',
		],
		[
			'the fields of an index with another name',
			{ code: 11000, errmsg: 'E11000 index: own_name dup key: { streamId: "a\nb", version: 1 }' },
			'stream-version',
		],
		['another index', { code: 11000, keyPattern: { email: 1 } }, 'other'],
		['no key at all', { code: 11000, message: 'E11000' }, 'other'],
		['another error', { code: 121 }, undefined],
		['no error', null, undefined],
	])('reads the key of a duplicate from %s', (_, error, key) => {
		expect(duplicateKeyOf(error)).toBe(key);
	});

	it('reads error labels and namespace conflicts', () => {
		expect(hasErrorLabel({ errorLabels: ['TransientTransactionError'] }, 'TransientTransactionError')).toBe(true);
		expect(hasErrorLabel({ hasErrorLabel: (label: string) => label === 'X' }, 'X')).toBe(true);
		expect(hasErrorLabel(undefined, 'X')).toBe(false);
		expect(isNamespaceExistsError({ code: 48 })).toBe(true);
		expect(isNamespaceExistsError(new Error('x'))).toBe(false);
	});
});
