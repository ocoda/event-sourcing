// @ocoda/event-sourcing-mongodb 4.0: migrates the collections of the default pools, `events` and `snapshots`, from the
// 3.x schema to schema v2 (ADR 0002 §6). Generated from lib/migration/plan.ts by `pnpm gen:migration-sql`; don't edit.
//
// MongoDBEventStore.migrate() and MongoDBSnapshotStore.migrate() do the same for every pool: they check the state
// before each step, skip what is done, resume an interrupted run and report. Prefer them. This script is for review,
// and for databases whose stores run with ddl: 'none'.
//
// 1. Take a backup, and make sure the oplog window and the disk have room (see the MongoDB integration guide).
// 2. Stop every 3.x instance.
// 3. Run it once, on the 3.x collections: mongosh "mongodb://<host>/<database of the stores>" 4.0.mongosh.js
// It stops at the first error; migrate() resumes a run that stopped. After step "register" 4.0 can run.

const owner = `mongosh-${new Date().toISOString()}`;
const catalog = db.getCollection('event_sourcing_collections');
const canonicalIds = db.getCollection('events').countDocuments({ _id: { $not: /^[0-9A-HJKMNP-TV-Z]{26}$/ } }) === 0;

// Events: fence 3.x writers off, number, index, register (the commit point), then clean up
// events: lease (lock: none)
db.getCollection('event_sourcing_collections').insertOne({
	_id: 'lock:migrate:events',
	kind: 'lock',
	owner: owner,
	expiresAt: new Date(Date.now() + 600000),
});

// events: fence (lock: exclusive collection lock for the collMod (milliseconds))
db.runCommand({
	collMod: 'events',
	validator: {
		$jsonSchema: {
			bsonType: 'object',
			required: ['globalPosition', 'streamId', 'version'],
			properties: { globalPosition: { bsonType: 'long' } },
		},
	},
	validationLevel: 'strict',
	validationAction: 'error',
});

// events: number (lock: intent locks: reads and writes go on), in 3.x's order and every stream in version order (ADR 0001 D33):
// by _id when every id is a canonical ULID (3.x derived eventDate from it), otherwise by (eventDate, _id)
if (canonicalIds) {
	db.getCollection('events').aggregate(
		[
			{ $setWindowFields: { sortBy: { _id: 1 }, output: { r: { $documentNumber: {} } } } },
			{ $project: { _id: 1, streamId: 1, version: 1, r: 1 } },
			{
				$setWindowFields: {
					partitionBy: '$streamId',
					sortBy: { version: 1 },
					output: { k: { $max: '$r', window: { documents: ['unbounded', 'current'] } } },
				},
			},
			{ $set: { orderKey: { $add: [{ $multiply: [{ $toLong: '$k' }, NumberLong('2147483648')] }, '$version'] } } },
			{ $setWindowFields: { sortBy: { orderKey: 1 }, output: { position: { $documentNumber: {} } } } },
			{ $project: { _id: 1, globalPosition: { $toLong: '$position' } } },
			{ $merge: { into: 'events', on: '_id', whenMatched: 'merge', whenNotMatched: 'fail' } },
		],
		{ allowDiskUse: true },
	);
} else {
	db.getCollection('events').aggregate(
		[
			{ $project: { _id: 1, streamId: 1, version: 1, rankKey: { $concat: ['$eventDate', '#', '$_id'] } } },
			{ $setWindowFields: { sortBy: { rankKey: 1 }, output: { r: { $documentNumber: {} } } } },
			{
				$setWindowFields: {
					partitionBy: '$streamId',
					sortBy: { version: 1 },
					output: { k: { $max: '$r', window: { documents: ['unbounded', 'current'] } } },
				},
			},
			{ $set: { orderKey: { $add: [{ $multiply: [{ $toLong: '$k' }, NumberLong('2147483648')] }, '$version'] } } },
			{ $setWindowFields: { sortBy: { orderKey: 1 }, output: { position: { $documentNumber: {} } } } },
			{ $project: { _id: 1, globalPosition: { $toLong: '$position' } } },
			{ $merge: { into: 'events', on: '_id', whenMatched: 'merge', whenNotMatched: 'fail' } },
		],
		{ allowDiskUse: true },
	);
}

// events: index (lock: exclusive collection lock at the start and the end of the index build)
db.getCollection('events').createIndex({ globalPosition: 1 }, { unique: true });

// events: register (lock: none)
db.getCollection('event_sourcing_collections').updateOne(
	{ _id: 'events' },
	{
		$setOnInsert: { kind: 'events' },
		$set: { schemaVersion: 2 },
		$max: {
			lastPosition:
				db.getCollection('events').find({}, { globalPosition: 1 }).sort({ globalPosition: -1 }).limit(1).next()
					?.globalPosition ?? NumberLong(0),
		},
	},
	{ upsert: true },
);

// events: drop-event-date-indexes (lock: exclusive collection lock (milliseconds))
db.getCollection('events').dropIndex('eventDate_1__id_1');

// events: unset-event-date (lock: intent locks: reads and writes go on)
db.getCollection('events').updateMany({ eventDate: { $exists: true } }, { $unset: { eventDate: '' } });

// events: release (lock: none)
db.getCollection('event_sourcing_collections').deleteOne({ _id: 'lock:migrate:events', owner: owner });

// Snapshots: one latest flag per stream, on its highest version, enforced by a unique index
// snapshots: lease (lock: none)
db.getCollection('event_sourcing_collections').insertOne({
	_id: 'lock:migrate:snapshots',
	kind: 'lock',
	owner: owner,
	expiresAt: new Date(Date.now() + 600000),
});

// snapshots: unset-null-latest (lock: intent locks: reads and writes go on)
db.getCollection('snapshots').updateMany({ latest: { $type: 'null' } }, { $unset: { latest: '' } });

// snapshots: repair-latest-flags (lock: intent locks: reads and writes go on)
db.getCollection('snapshots')
	.aggregate(
		[
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
		],
		{ allowDiskUse: true },
	)
	.forEach(({ _id, top }) => {
		db.getCollection('snapshots').updateMany(
			{ streamId: _id, _id: { $ne: top }, latest: { $exists: true } },
			{ $unset: { latest: '' } },
		);
		db.getCollection('snapshots').updateOne({ _id: top }, { $set: { latest: 'latest#' + _id } });
	});

// snapshots: index (lock: exclusive collection lock at the start and the end of the index build)
db.getCollection('snapshots').createIndex(
	{ aggregateName: 1, latest: 1 },
	{ unique: true, partialFilterExpression: { latest: { $type: 'string' } }, name: 'latest_unique' },
);

// snapshots: drop-latest-indexes (lock: exclusive collection lock (milliseconds))
db.getCollection('snapshots').dropIndex('aggregateName_1_latest_1');

// snapshots: register (lock: none)
db.getCollection('event_sourcing_collections').updateOne(
	{ _id: 'snapshots' },
	{ $setOnInsert: { kind: 'snapshots' }, $set: { schemaVersion: 2 } },
	{ upsert: true },
);

// snapshots: release (lock: none)
db.getCollection('event_sourcing_collections').deleteOne({ _id: 'lock:migrate:snapshots', owner: owner });

print(
	`Migrated events and snapshots; ${catalog.countDocuments({ _id: { $in: ['events', 'snapshots'] }, schemaVersion: 2 })} of 2 collections registered with schema version 2.`,
);
