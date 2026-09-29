import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	EventId,
	EventStoreSchemaException,
	EventStream,
	type MigrationCollectionReport,
	type MigrationProgress,
	SnapshotCollection,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import { MongoDBEventStore, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { Account, AccountId, getEventMap, getEvents, mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import type { Db, Document } from 'mongodb';
import { migrationHooks } from '../../lib/migration/runner.js';
import {
	createV1EventCollection,
	createV1SnapshotCollection,
	v1EventDocument,
	v1SnapshotDocument,
} from '../fixtures/schema-v1.js';
import { drain, expectRejectionOfClass } from '../support/assertions.js';
import { CATALOG, dropCollections, rawCollection } from '../support/catalog.js';
import { createEventStore, createSnapshotStore } from '../support/stores.js';

// The migration of 3.x collections (ADR 0002 §6, MongoDB). Every test seeds 3.x collections of its own (the 3.0.0 and
// 3.0.2 DDL of tests/fixtures/schema-v1.ts) and migrates only those, by pool: other specs share the database.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type V1Event = ReturnType<typeof v1EventDocument>;

const EVENT_STEPS = [
	'lease',
	'fence',
	'number',
	'index',
	'register',
	'drop-event-date-indexes',
	'unset-event-date',
	'release',
];

const SNAPSHOT_STEPS = [
	'lease',
	'unset-null-latest',
	'repair-latest-flags',
	'index',
	'drop-latest-indexes',
	'register',
	'release',
];

const newStream = () => EventStream.for(Account, AccountId.generate());

/** A canonical event id of a millisecond, and a lower-case (non-canonical) one that 3.x accepted too. */
const idAt = (time: number) => EventId.generate(new Date(time)).value;

/**
 * 3.x events with the edge cases of the numbering: interleaved streams across a month boundary, several events per
 * millisecond, a stream whose later version has the lower id (separate appends in one millisecond), a gapped stream,
 * a stream that starts at version 2, and optionally events with non-canonical (lower-case) ids.
 */
const corpus = ({ nonCanonical = false } = {}): V1Event[] => {
	const events: V1Event[] = [];
	const t0 = Date.UTC(2021, 0, 31, 23, 59, 59, 990);
	const [a, b, gapped, late, inverted, lower] = Array.from({ length: 6 }, newStream);
	for (let version = 1; version <= 4; version++) {
		events.push(v1EventDocument(a, version, { eventId: idAt(t0 + version * 7) }));
		events.push(v1EventDocument(b, version, { eventId: idAt(t0 + version * 7), correlationId: `c-${version}` }));
	}
	for (const [index, version] of [1, 2, 3, 5].entries()) {
		events.push(v1EventDocument(gapped, version, { eventId: idAt(t0 + 100 + index) }));
	}
	events.push(v1EventDocument(late, 2, { eventId: idAt(t0 + 5) }));
	const [low, high] = [idAt(t0 + 50), idAt(t0 + 50)].sort();
	events.push(v1EventDocument(inverted, 1, { eventId: high }));
	events.push(v1EventDocument(inverted, 2, { eventId: low }));
	if (nonCanonical) {
		events.push(v1EventDocument(lower, 1, { eventId: idAt(t0 + 60).toLowerCase() }));
		events.push(v1EventDocument(lower, 2, { eventId: idAt(t0 + 61) }));
	}
	return events;
};

/**
 * The positions ADR 0001 D33 prescribes, computed in JS: the rank `r` in 3.x's order `(eventDate, _id, streamId,
 * version)`, the running maximum `k` of `r` over the stream in version order, then the order of `(k, version)`.
 */
const expectedPositions = (events: readonly V1Event[]): Map<string, number> => {
	const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
	const ranked = [...events].sort(
		(x, y) =>
			compare(x.eventDate, y.eventDate) ||
			compare(x._id, y._id) ||
			compare(x.streamId, y.streamId) ||
			compare(x.version, y.version),
	);
	const rank = new Map(ranked.map((event, index) => [event._id, index + 1]));
	const key = new Map<string, number>();
	const byStream = new Map<string, V1Event[]>();
	for (const event of events) {
		byStream.set(event.streamId, [...(byStream.get(event.streamId) ?? []), event]);
	}
	for (const streamEvents of byStream.values()) {
		let max = 0;
		for (const event of [...streamEvents].sort((x, y) => x.version - y.version)) {
			max = Math.max(max, rank.get(event._id) as number);
			key.set(event._id, max);
		}
	}
	const ordered = [...events].sort(
		(x, y) => compare(key.get(x._id) as number, key.get(y._id) as number) || compare(x.version, y.version),
	);
	return new Map(ordered.map((event, index) => [event._id, index + 1]));
};

describe.each(mongodbTestTopologies())('MongoDB migration ($name)', ({ url }) => {
	const eventMap = getEventMap();
	let eventStore: MongoDBEventStore;
	let snapshotStore: MongoDBSnapshotStore;
	let database: Db;
	const collections: string[] = [];

	const pool = (label: string) => {
		const name = `mig-${label}-${randomBytes(4).toString('hex')}`;
		collections.push(EventCollection.get(name), SnapshotCollection.get(name));
		return name;
	};
	const catalog = () => rawCollection(database, CATALOG);

	const seedEvents = async (events: readonly V1Event[], label = 'events') => {
		const eventPool = pool(label);
		await createV1EventCollection(database, EventCollection.get(eventPool));
		if (events.length > 0) {
			await rawCollection(database, EventCollection.get(eventPool)).insertMany(events.map((event) => ({ ...event })));
		}
		return eventPool;
	};

	/** Everything the migration may change: options, indexes, documents (positions as Longs) and catalog documents. */
	const dump = async (name: string) => {
		const [info] = await database.listCollections({ name }).toArray();
		const indexes = (await rawCollection(database, name).indexes())
			.map(({ name: index, key, unique, partialFilterExpression }) => ({ index, key, unique, partialFilterExpression }))
			.sort((x, y) => String(x.index).localeCompare(String(y.index)));
		const documents = await rawCollection(database, name).find({}, { promoteLongs: false }).sort({ _id: 1 }).toArray();
		const registered = await catalog()
			.find({ _id: { $in: [name, `lock:migrate:${name}`] } }, { projection: { _id: 0 } })
			.toArray();
		return { options: (info as { options?: Document } | undefined)?.options, indexes, documents, registered };
	};

	const migrateEvents = (eventPool: string, options: Parameters<MongoDBEventStore['migrate']>[0] = {}) =>
		eventStore.migrate({ pools: [eventPool], ...options });

	const reportOf = async (promise: Promise<{ collections: MigrationCollectionReport[] }>) => {
		const {
			collections: [report],
		} = await promise;
		return report;
	};

	beforeAll(async () => {
		({ store: eventStore } = createEventStore({ url }, eventMap));
		snapshotStore = createSnapshotStore({ url });
		await Promise.all([eventStore.connect(), snapshotStore.connect()]);
		database = eventStore['database'];
	});

	afterEach(() => {
		migrationHooks.onStepComplete = undefined;
	});

	afterAll(async () => {
		await dropCollections(database, collections);
		await Promise.all([eventStore.disconnect(), snapshotStore.disconnect()]);
	});

	describe('events', () => {
		it('plans without writing anything in a dry run', async () => {
			const events = corpus({ nonCanonical: true });
			const eventPool = await seedEvents(events);
			const collection = EventCollection.get(eventPool);
			const before = await dump(collection);

			const report = await eventStore.migrate({ pools: [eventPool], dryRun: true });

			expect(report).toMatchObject({ dryRun: true, environment: { serverVersion: expect.any(String) } });
			expect(report.environment.timeZones.process).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
			const [collectionReport] = report.collections;
			expect(collectionReport).toMatchObject({
				name: collection,
				kind: 'events',
				from: 'v1',
				action: 'migrate',
				rows: events.length,
				bytes: expect.any(Number),
				nonCrockfordEventIds: 1,
				droppedIndexes: ['eventDate_1__id_1'],
				blocking: [],
			});
			expect(collectionReport.gappedStreams).toEqual({
				total: 2,
				sample: expect.arrayContaining([
					expect.objectContaining({ events: 4, minVersion: 1, maxVersion: 5 }),
					expect.objectContaining({ events: 1, minVersion: 2, maxVersion: 2 }),
				]),
			});
			expect(collectionReport.steps.map(({ name, status }) => [name, status])).toEqual(
				EVENT_STEPS.map((step) => [step, 'pending']),
			);
			expect(collectionReport.steps.find(({ name }) => name === 'number')?.statement).toContain(
				"$concat: ['$eventDate', '#', '$_id']",
			);
			expect(collectionReport.warnings).toEqual(
				expect.arrayContaining([
					expect.stringContaining('2 stream(s) have gaps'),
					expect.stringContaining('not canonical'),
				]),
			);
			expect(await dump(collection)).toEqual(before);
		});

		it.each([
			['_id', false],
			['(eventDate, _id)', true],
		])(
			'numbers the events by %s in 3.x order, every stream in version order, and 4.0 continues after them',
			async (_, nonCanonical) => {
				const events = corpus({ nonCanonical });
				const eventPool = await seedEvents(events);
				const collection = EventCollection.get(eventPool);

				const report = await reportOf(migrateEvents(eventPool));

				expect(report).toMatchObject({ from: 'v1', action: 'migrate' });
				expect(report.steps.every(({ status }) => status === 'done')).toBe(true);
				expect(report.steps.find(({ name }) => name === 'number')?.statement).toContain(
					nonCanonical ? '$concat' : 'sortBy: { _id: 1 }',
				);

				// Positions 1..N as D33 prescribes, 64-bit, and 3.x's fields otherwise unchanged except eventDate
				const expected = expectedPositions(events);
				const migrated = await rawCollection(database, collection).find({}, { promoteLongs: false }).toArray();
				expect(
					Object.fromEntries(migrated.map(({ _id, globalPosition }) => [_id, Number(String(globalPosition))])),
				).toEqual(Object.fromEntries(expected));
				expect(await rawCollection(database, collection).countDocuments({ globalPosition: { $type: 'long' } })).toBe(
					events.length,
				);
				for (const event of events) {
					const { eventDate: _, ...kept } = event;
					expect(migrated.find(({ _id }) => _id === event._id)).toEqual({
						...kept,
						globalPosition: expect.anything(),
					});
				}
				expect((await rawCollection(database, collection).indexes()).map(({ key }) => key)).toEqual([
					{ _id: 1 },
					{ streamId: 1, version: 1 },
					{ globalPosition: 1 },
				]);
				expect(await catalog().findOne({ _id: collection })).toMatchObject({
					kind: 'events',
					schemaVersion: 2,
					lastPosition: events.length,
				});
				expect(await catalog().countDocuments({ _id: `lock:migrate:${collection}` })).toBe(0);

				// readAll yields every stream in version order, and the envelopes keep 3.x's fields
				const all = await drain(eventStore.readAll({ pool: eventPool }));
				expect(all.map(({ metadata }) => metadata.eventId.value)).toEqual(
					[...expected].sort(([, x], [, y]) => x - y).map(([id]) => id),
				);
				for (const streamId of new Set(events.map(({ streamId }) => streamId))) {
					const versions = all.filter(({ metadata }) => `account-${metadata.aggregateId}` === streamId);
					expect(versions.map(({ metadata }) => metadata.version)).toEqual(
						events
							.filter((event) => event.streamId === streamId)
							.map(({ version }) => version)
							.sort((x, y) => x - y),
					);
				}
				const [first] = all;
				const source = events.find(({ _id }) => _id === first.metadata.eventId.value) as V1Event;
				expect(first.metadata.occurredOn).toEqual(source.occurredOn);
				expect(first.metadata).not.toHaveProperty('causationId');

				// A 3.x-shaped insert is rejected; 4.0 bootstraps and continues at N + 1
				await expect(
					rawCollection(database, collection).insertOne(v1EventDocument(newStream(), 1)),
				).rejects.toMatchObject({
					code: 121,
				});
				await expect(eventStore.ensureCollection(eventPool)).resolves.toBe(collection);
				const [appended] = await eventStore.appendEvents(newStream(), getEvents().slice(0, 1), {
					expectedVersion: 0,
					pool: eventPool,
				});
				expect(appended.metadata.globalPosition).toBe(BigInt(events.length + 1));

				// A second run skips everything
				const again = await reportOf(migrateEvents(eventPool));
				expect(again).toMatchObject({ from: 'v2', action: 'skip' });
				expect(again.steps.every(({ status }) => status === 'skipped')).toBe(true);
			},
		);

		it('resumes after a crash after any step, to the same collection as a run without one', async () => {
			const events = corpus({ nonCanonical: true });
			const clean = await seedEvents(events, 'clean');
			await migrateEvents(clean);
			const expected = await dump(EventCollection.get(clean));

			for (const crashAfter of EVENT_STEPS) {
				const eventPool = await seedEvents(events, `crash-${crashAfter}`);
				const collection = EventCollection.get(eventPool);
				migrationHooks.onStepComplete = (_, step) => {
					if (step === crashAfter) throw new Error(`crash after ${step}`);
				};
				await expect(migrateEvents(eventPool)).rejects.toThrow(`crash after ${crashAfter}`);
				migrationHooks.onStepComplete = undefined;

				const registered = EVENT_STEPS.indexOf(crashAfter) >= EVENT_STEPS.indexOf('register');
				if (!registered) {
					await expectRejectionOfClass(eventStore.ensureCollection(eventPool), EventStoreSchemaException, {
						found: crashAfter === 'lease' ? 'v1' : 'v1-partial',
					});
				}

				// A crash after the last step that writes leaves only the release, which the crashed run did on its way out
				const resumed = await reportOf(migrateEvents(eventPool));
				expect(resumed.action, `after a crash after ${crashAfter}`).toBe(
					crashAfter === 'release' || crashAfter === 'unset-event-date'
						? 'skip'
						: crashAfter === 'lease'
							? 'migrate'
							: 'resume',
				);
				expect(await dump(collection), `after a crash after ${crashAfter}`).toEqual(expected);
			}
		});

		it('defers the removal of eventDate with unsetEventDate: false, and a later run finishes it', async () => {
			const eventPool = await seedEvents(corpus());
			const collection = EventCollection.get(eventPool);

			const deferred = await reportOf(migrateEvents(eventPool, { unsetEventDate: false }));
			expect(deferred.steps.find(({ name }) => name === 'unset-event-date')?.status).toBe('skipped');
			expect(deferred.warnings).toContainEqual(expect.stringContaining('eventDate is kept'));
			expect(
				await rawCollection(database, collection).countDocuments({ eventDate: { $exists: true } }),
			).toBeGreaterThan(0);
			await expect(eventStore.ensureCollection(eventPool)).resolves.toBe(collection);

			const progress: MigrationProgress[] = [];
			const finished = await reportOf(migrateEvents(eventPool, { onProgress: (step) => progress.push(step) }));
			expect(finished).toMatchObject({ from: 'v2', action: 'resume' });
			expect(finished.steps.filter(({ status }) => status === 'done').map(({ name }) => name)).toEqual([
				'lease',
				'unset-event-date',
				'release',
			]);
			expect(await rawCollection(database, collection).countDocuments({ eventDate: { $exists: true } })).toBe(0);
			expect(progress).toContainEqual({
				collection,
				step: 'unset-event-date',
				done: expect.any(Number),
				total: expect.any(Number),
			});
		});

		it('blocks collections it cannot migrate, and writes nothing to them', async () => {
			const withObjectId = await seedEvents([]);
			await rawCollection(database, EventCollection.get(withObjectId)).insertOne({
				streamId: 's',
				version: 1,
				eventDate: '2021-01',
			});
			const withoutEventDate = await seedEvents([v1EventDocument(newStream(), 1, { eventId: idAt(0).toLowerCase() })]);
			await rawCollection(database, EventCollection.get(withoutEventDate)).updateMany(
				{},
				{ $unset: { eventDate: '' } },
			);
			const withValidator = await seedEvents(corpus());
			await database.command({ collMod: EventCollection.get(withValidator), validator: { version: { $gte: 1 } } });

			const report = await eventStore.migrate({ pools: [withObjectId, withoutEventDate, withValidator] });

			expect(report.collections.map(({ action, blocking }) => [action, blocking])).toEqual([
				['blocked', [expect.stringContaining('_id that is not a string')]],
				['blocked', [expect.stringContaining('no eventDate')]],
				['blocked', [expect.stringContaining('validator of its own')]],
			]);
			for (const { steps } of report.collections) {
				expect(steps.every(({ status }) => status === 'skipped')).toBe(true);
			}
			expect(await catalog().countDocuments({ _id: { $in: report.collections.map(({ name }) => name) } })).toBe(0);
		});

		it('waits for the lease of another run, unless it expired or force takes it over', async () => {
			const eventPool = await seedEvents(corpus());
			const collection = EventCollection.get(eventPool);
			const lease = (expiresAt: Date) =>
				catalog().replaceOne(
					{ _id: `lock:migrate:${collection}` },
					{ kind: 'lock', owner: 'another-run', expiresAt },
					{ upsert: true },
				);

			await lease(new Date(Date.now() + 60_000));
			const blocked = await reportOf(migrateEvents(eventPool));
			expect(blocked).toMatchObject({ action: 'blocked', blocking: [expect.stringContaining('another migration')] });
			expect(await catalog().countDocuments({ _id: collection })).toBe(0);

			const forced = await reportOf(migrateEvents(eventPool, { force: true }));
			expect(forced).toMatchObject({
				action: 'migrate',
				warnings: expect.arrayContaining([expect.stringContaining('taken over')]),
			});
			expect(await catalog().countDocuments({ _id: `lock:migrate:${collection}` })).toBe(0);

			const expired = await seedEvents(corpus());
			await catalog().insertOne({
				_id: `lock:migrate:${EventCollection.get(expired)}`,
				kind: 'lock',
				owner: 'crashed-run',
				expiresAt: new Date(Date.now() - 1000),
			});
			expect(await reportOf(migrateEvents(expired))).toMatchObject({
				action: 'migrate',
				warnings: expect.arrayContaining([expect.stringContaining('expired')]),
			});
		});

		it('migrates without a bootstrapped store, and discovers the collections by name and shape', async () => {
			const databaseName = `es_mgo_discovery_${randomBytes(4).toString('hex')}`;
			const own = new URL(url);
			own.pathname = `/${databaseName}`;
			const ownDatabase = eventStore['client']?.db(databaseName) as Db;
			try {
				await createV1EventCollection(ownDatabase, 'events');
				await rawCollection(ownDatabase, 'events').insertMany(corpus());
				await createV1EventCollection(ownDatabase, 'tenant-events');
				await rawCollection(ownDatabase, 'not-an-event-collection').insertOne({ a: 1 });
				await rawCollection(ownDatabase, 'other-events').insertOne({ a: 1 });
				await createV1SnapshotCollection(ownDatabase, 'snapshots');

				const report = await MongoDBEventStore.migrate({ url: own.toString() });

				expect(report.collections.map(({ name, action }) => [name, action])).toEqual([
					['events', 'migrate'],
					['tenant-events', 'migrate'],
				]);
				const snapshots = await MongoDBSnapshotStore.migrate({ url: own.toString() }, { dryRun: true });
				expect(snapshots.collections.map(({ name, from }) => [name, from])).toEqual([['snapshots', 'v1']]);
			} finally {
				await ownDatabase.dropDatabase();
			}
		});
	});

	describe('snapshots', () => {
		/**
		 * A 3.x snapshot collection: a healthy stream, one with two flags, one without a flag and one whose flag sits on a
		 * lower version.
		 */
		const seedSnapshots = async () => {
			const snapshotPool = pool('snapshots');
			const collection = SnapshotCollection.get(snapshotPool);
			await createV1SnapshotCollection(database, collection);
			const [healthy, duplicate, missing, misflagged] = Array.from({ length: 4 }, () =>
				SnapshotStream.for(Account, AccountId.generate()),
			);
			await rawCollection(database, collection).insertMany([
				v1SnapshotDocument(healthy, 1, false),
				v1SnapshotDocument(healthy, 2, false),
				v1SnapshotDocument(healthy, 3, true),
				v1SnapshotDocument(duplicate, 1, true),
				v1SnapshotDocument(duplicate, 2, true),
				v1SnapshotDocument(missing, 1, false),
				v1SnapshotDocument(missing, 2, false),
				v1SnapshotDocument(misflagged, 1, true),
				v1SnapshotDocument(misflagged, 2, false),
			]);
			return { snapshotPool, collection, streams: { healthy, duplicate, missing, misflagged } };
		};

		const flags = async (collection: string) =>
			(
				await rawCollection(database, collection)
					.find({ latest: { $exists: true } })
					.sort({ latest: 1 })
					.toArray()
			).map(({ streamId, version, latest }) => [streamId, version, latest]);

		it('reports the flags to repair in a dry run, without writing', async () => {
			const { snapshotPool, collection } = await seedSnapshots();
			const before = await dump(collection);

			const report = await reportOf(snapshotStore.migrate({ pools: [snapshotPool], dryRun: true }));

			expect(report).toMatchObject({
				name: collection,
				kind: 'snapshots',
				from: 'v1',
				action: 'migrate',
				rows: 9,
				snapshotFlags: { duplicateLatest: 1, missingLatest: 1 },
				droppedIndexes: ['aggregateName_1_latest_1'],
				warnings: [expect.stringContaining('1 stream(s) flag a snapshot that is not their highest version')],
			});
			expect(report.steps.map(({ name, status }) => [name, status])).toEqual(
				SNAPSHOT_STEPS.map((step) => [step, 'pending']),
			);
			expect(await dump(collection)).toEqual(before);
		});

		it('flags exactly the highest version of every stream, and enforces it with a unique index', async () => {
			const { snapshotPool, collection, streams } = await seedSnapshots();

			const report = await reportOf(snapshotStore.migrate({ pools: [snapshotPool] }));

			expect(report.steps.every(({ status }) => status === 'done')).toBe(true);
			expect(await rawCollection(database, collection).countDocuments({ latest: { $type: 'null' } })).toBe(0);
			expect(await flags(collection)).toEqual(
				Object.values(streams)
					.map((stream) => [stream.streamId, stream === streams.healthy ? 3 : 2, `latest#${stream.streamId}`])
					.sort(([x], [y]) => (String(x) < String(y) ? -1 : 1)),
			);
			const indexes = await rawCollection(database, collection).indexes();
			expect(indexes.map(({ name }) => name)).toEqual(['_id_', 'streamId_1_version_1', 'latest_unique']);
			expect(indexes.find(({ name }) => name === 'latest_unique')).toMatchObject({
				unique: true,
				partialFilterExpression: { latest: { $type: 'string' } },
			});
			expect(await catalog().findOne({ _id: collection })).toMatchObject({ kind: 'snapshots', schemaVersion: 2 });

			// The store appends and reads as it does on a new collection
			await snapshotStore.ensureCollection(snapshotPool);
			await snapshotStore.appendSnapshot(streams.missing, 3, { balance: 3 }, snapshotPool);
			expect((await snapshotStore.getLastEnvelope(streams.missing, snapshotPool))?.metadata.version).toBe(3);
			const latest = await drain(snapshotStore.getLastEnvelopesForAggregate(Account, { pool: snapshotPool }));
			expect(latest.map(({ metadata }) => metadata.version).sort()).toEqual([2, 2, 3, 3]);

			const again = await reportOf(snapshotStore.migrate({ pools: [snapshotPool] }));
			expect(again).toMatchObject({ from: 'v2', action: 'skip' });
		});

		it('resumes after a crash after any step, to the same flags and indexes', async () => {
			for (const crashAfter of SNAPSHOT_STEPS) {
				const { snapshotPool, collection, streams } = await seedSnapshots();
				migrationHooks.onStepComplete = (_, step) => {
					if (step === crashAfter) throw new Error(`crash after ${step}`);
				};
				await expect(snapshotStore.migrate({ pools: [snapshotPool] })).rejects.toThrow(`crash after ${crashAfter}`);
				migrationHooks.onStepComplete = undefined;

				await snapshotStore.migrate({ pools: [snapshotPool] });

				expect(
					(await flags(collection)).map(([, version]) => version).sort(),
					`after a crash after ${crashAfter}`,
				).toEqual([2, 2, 2, 3]);
				expect((await rawCollection(database, collection).indexes()).map(({ name }) => name)).toEqual([
					'_id_',
					'streamId_1_version_1',
					'latest_unique',
				]);
				expect(await catalog().findOne({ _id: collection })).toMatchObject({ schemaVersion: 2 });
				expect((await snapshotStore.getLastEnvelope(streams.healthy, snapshotPool))?.metadata.version).toBe(3);
			}
		});
	});
});
