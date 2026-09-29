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
import {
	Collection,
	Db,
	type Document,
	Double,
	type MongoClient,
	type MongoClientOptions,
	MongoServerError,
} from 'mongodb';
import { numberingPipeline } from '../../lib/migration/plan.js';
import { MIGRATION_LIMITS, migrationHooks } from '../../lib/migration/runner.js';
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

		it('blocks, and numbers nothing, when another run leases the collection after its first look', async () => {
			const eventPool = await seedEvents(corpus());
			const collection = EventCollection.get(eventPool);
			const before = await dump(collection);
			// The other run's lease lands between this run's first look (which saw none) and its own lease
			const insertOne = Collection.prototype.insertOne;
			vi.spyOn(Collection.prototype, 'insertOne').mockImplementationOnce(async function (
				this: Collection,
				...args: Parameters<Collection['insertOne']>
			) {
				await catalog().insertOne({
					_id: `lock:migrate:${collection}`,
					kind: 'lock',
					owner: 'other',
					expiresAt: new Date(Date.now() + 60_000),
				});
				return insertOne.apply(this, args);
			});

			const report = await reportOf(migrateEvents(eventPool));

			expect(report).toMatchObject({ action: 'blocked', blocking: [expect.stringContaining('another migration')] });
			expect(report.steps.every(({ status }) => status === 'skipped')).toBe(true);
			// Only the other run's lease was written
			const after = await dump(collection);
			expect({ ...after, registered: before.registered }).toEqual(before);
			expect(after.registered).toEqual([{ kind: 'lock', owner: 'other', expiresAt: expect.any(Date) }]);
		});

		it('renews its lease while it runs', async () => {
			const eventPool = await seedEvents(corpus());
			const collection = EventCollection.get(eventPool);
			MIGRATION_LIMITS.leaseRenewalMs = 20;
			onTestFinished(() => {
				MIGRATION_LIMITS.leaseRenewalMs = 60_000;
			});
			const expiries: number[] = [];
			migrationHooks.onStepComplete = async (_, step) => {
				if (step === 'fence') {
					const leaseExpiry = async () =>
						Number((await catalog().findOne({ _id: `lock:migrate:${collection}` }))?.expiresAt);
					expiries.push(await leaseExpiry());
					// A slow step
					await new Promise((resolve) => setTimeout(resolve, 150));
					expiries.push(await leaseExpiry());
				}
			};

			await expect(reportOf(migrateEvents(eventPool))).resolves.toMatchObject({ action: 'migrate' });

			expect(expiries[1]).toBeGreaterThan(expiries[0]);
		});

		it('stops before its next step, blocked, when another run took its lease over', async () => {
			const eventPool = await seedEvents(corpus());
			const collection = EventCollection.get(eventPool);
			migrationHooks.onStepComplete = async (_, step) => {
				if (step === 'fence') {
					// Another run, started with force: true
					await catalog().updateOne({ _id: `lock:migrate:${collection}` }, { $set: { owner: 'usurper' } });
				}
			};

			const report = await reportOf(migrateEvents(eventPool));

			expect(report).toMatchObject({ action: 'blocked', blocking: [expect.stringContaining('took the lease')] });
			expect(report.steps.map(({ name, status }) => [name, status])).toEqual(
				EVENT_STEPS.map((step) => [step, step === 'lease' || step === 'fence' ? 'done' : 'skipped']),
			);
			expect(await rawCollection(database, collection).countDocuments({ globalPosition: { $exists: true } })).toBe(0);
			// The lease of the other run stays
			expect(await catalog().findOne({ _id: `lock:migrate:${collection}` })).toMatchObject({ owner: 'usurper' });
		});

		it('leaves the lease of a run that died, which blocks a rerun until force takes it over', async () => {
			const events = corpus();
			const clean = await seedEvents(events, 'clean');
			await migrateEvents(clean);
			const expected = await dump(EventCollection.get(clean));

			const eventPool = await seedEvents(events, 'died');
			const collection = EventCollection.get(eventPool);
			migrationHooks.onStepComplete = async (_, step) => {
				if (step === 'number') {
					// The process dies: nothing releases its lease (the lease now belongs to nobody that runs)
					await catalog().updateOne({ _id: `lock:migrate:${collection}` }, { $set: { owner: 'dead-run' } });
					throw new Error('the process died');
				}
			};
			await expect(migrateEvents(eventPool)).rejects.toThrow('the process died');
			migrationHooks.onStepComplete = undefined;
			const afterCrash = await dump(collection);

			const blocked = await reportOf(migrateEvents(eventPool));
			expect(blocked).toMatchObject({ action: 'blocked', blocking: [expect.stringContaining('force: true')] });
			expect(await dump(collection)).toEqual(afterCrash);

			const forced = await reportOf(migrateEvents(eventPool, { force: true }));
			expect(forced).toMatchObject({ action: 'resume' });
			expect(forced.steps.filter(({ status }) => status === 'skipped').map(({ name }) => name)).toEqual([
				'fence',
				'number',
			]);
			expect(await dump(collection)).toEqual(expected);
		});

		it('numbers a 3.x collection that looked empty, when a 3.x writer inserts before the fence', async () => {
			const eventPool = await seedEvents([]);
			const collection = EventCollection.get(eventPool);
			const late = v1EventDocument(newStream(), 1);
			migrationHooks.onStepComplete = async (_, step) => {
				if (step === 'lease') {
					await rawCollection(database, collection).insertOne(late);
				}
			};

			const report = await reportOf(migrateEvents(eventPool));

			expect(report.steps.find(({ name }) => name === 'number')?.status).toBe('done');
			expect(await drain(eventStore.readAll({ pool: eventPool }))).toMatchObject([
				{ metadata: { eventId: expect.objectContaining({ value: late._id }), globalPosition: 1n } },
			]);
		});

		it('keeps the versions of a stream apart when they are stored as doubles', async () => {
			const orderKey = numberingPipeline('events', 'id').find((stage) => '$set' in stage) as Document;
			// k past 2^22: (k * 2^31 + version) is past 2^53, where a double can't tell the versions apart
			const keys = await database
				.aggregate([
					{
						$documents: [
							{ k: 4_194_309, version: new Double(3) },
							{ k: 4_194_309, version: new Double(4) },
						],
					},
					orderKey,
					{ $project: { _id: 0, orderKey: 1, type: { $type: '$orderKey' } } },
				])
				.toArray();

			expect(keys.map(({ type }) => type)).toEqual(['long', 'long']);
			expect(String(keys[1].orderKey)).not.toBe(String(keys[0].orderKey));
		});

		it('reports a collection as blocked when the fence does not get its lock within lockTimeoutMs', async () => {
			const eventPool = await seedEvents(corpus());
			const collection = EventCollection.get(eventPool);
			const command = Db.prototype.command;
			const commands: Document[] = [];
			vi.spyOn(Db.prototype, 'command').mockImplementation(async function (
				this: Db,
				...args: Parameters<Db['command']>
			) {
				if ('collMod' in args[0]) {
					commands.push(args[0]);
					throw new MongoServerError({
						code: 50,
						codeName: 'MaxTimeMSExpired',
						errmsg: 'operation exceeded time limit',
					});
				}
				return command.apply(this, args);
			});

			const report = await reportOf(migrateEvents(eventPool, { lockTimeoutMs: 1234 }));

			expect(commands).toEqual([expect.objectContaining({ collMod: collection, maxTimeMS: 1234 })]);
			expect(report).toMatchObject({ action: 'blocked', blocking: [expect.stringContaining('lockTimeoutMs')] });
			expect(report.steps.map(({ name, status }) => [name, status])).toEqual(
				EVENT_STEPS.map((step) => [step, step === 'lease' ? 'done' : 'skipped']),
			);
			expect(await catalog().countDocuments({ _id: { $in: [collection, `lock:migrate:${collection}`] } })).toBe(0);
		});

		it('rethrows a failure to drop an eventDate index, other than an index that is gone', async () => {
			const eventPool = await seedEvents(corpus());
			const denied = new MongoServerError({ code: 13, codeName: 'Unauthorized', errmsg: 'not authorized' });
			const dropIndex = vi.spyOn(Collection.prototype, 'dropIndex').mockRejectedValueOnce(denied);

			await expect(migrateEvents(eventPool)).rejects.toBe(denied);
			expect(dropIndex).toHaveBeenCalledWith('eventDate_1__id_1', { maxTimeMS: 10_000 });

			// An index that is gone by now is no failure
			dropIndex.mockRejectedValueOnce(new MongoServerError({ code: 27, codeName: 'IndexNotFound', errmsg: 'gone' }));
			await expect(reportOf(migrateEvents(eventPool))).resolves.toMatchObject({ action: 'resume' });
		});

		it('reports the privileges an authenticated user lacks, before writing', async () => {
			const eventPool = await seedEvents(corpus());
			const collection = EventCollection.get(eventPool);
			const command = Db.prototype.command;
			vi.spyOn(Db.prototype, 'command').mockImplementation(async function (
				this: Db,
				...args: Parameters<Db['command']>
			) {
				if ('connectionStatus' in args[0]) {
					// A user with the readWrite role only, as connectionStatus reports it
					return {
						authInfo: {
							authenticatedUsers: [{ user: 'app', db: 'admin' }],
							authenticatedUserRoles: [{ role: 'readWrite', db: database.databaseName }],
							authenticatedUserPrivileges: [
								{
									resource: { db: database.databaseName, collection: '' },
									actions: ['find', 'insert', 'update', 'remove', 'listIndexes', 'createIndex', 'dropIndex'],
								},
							],
						},
						ok: 1,
					};
				}
				return command.apply(this, args);
			});

			const report = await reportOf(migrateEvents(eventPool, { dryRun: true }));

			expect(report).toMatchObject({
				action: 'blocked',
				blocking: [expect.stringContaining(`collMod on ${database.databaseName}.${collection}`)],
			});
		});

		it('leaves the client timeouts of the config out of the client of a static migration', async () => {
			const clientOptions: Partial<MongoClientOptions>[] = [];
			const capture = function (this: { client: MongoClient }) {
				clientOptions.push(this.client.options);
				return Promise.resolve({ dryRun: true, environment: {}, collections: [] } as never);
			};
			vi.spyOn(MongoDBEventStore.prototype, 'migrate').mockImplementation(capture);
			vi.spyOn(MongoDBSnapshotStore.prototype, 'migrate').mockImplementation(capture);
			const separator = url.includes('?') ? '&' : '?';
			const config = { url: `${url}${separator}socketTimeoutMS=1500&timeoutMS=2000`, socketTimeoutMS: 1500 };

			await MongoDBEventStore.migrate(config, { dryRun: true });
			await MongoDBSnapshotStore.migrate({ ...config, timeoutMS: 2000 }, { dryRun: true });

			for (const options of clientOptions) {
				expect(options).toMatchObject({ socketTimeoutMS: 0 });
				expect(options.timeoutMS).toBeUndefined();
			}
			expect(clientOptions).toHaveLength(2);
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
		 * The snapshots of a 3.x collection: a healthy stream, one with two flags, one without a flag and one whose flag
		 * sits on a lower version.
		 */
		const snapshotCorpus = () => {
			const [healthy, duplicate, missing, misflagged] = Array.from({ length: 4 }, () =>
				SnapshotStream.for(Account, AccountId.generate()),
			);
			const documents = [
				v1SnapshotDocument(healthy, 1, false),
				v1SnapshotDocument(healthy, 2, false),
				v1SnapshotDocument(healthy, 3, true),
				v1SnapshotDocument(duplicate, 1, true),
				v1SnapshotDocument(duplicate, 2, true),
				v1SnapshotDocument(missing, 1, false),
				v1SnapshotDocument(missing, 2, false),
				v1SnapshotDocument(misflagged, 1, true),
				v1SnapshotDocument(misflagged, 2, false),
			];
			return { documents, streams: { healthy, duplicate, missing, misflagged } };
		};

		/** A 3.x snapshot collection of its own with the corpus (a new one, or the given one: the same documents). */
		const seedSnapshots = async ({ documents, streams } = snapshotCorpus()) => {
			const snapshotPool = pool('snapshots');
			const collection = SnapshotCollection.get(snapshotPool);
			await createV1SnapshotCollection(database, collection);
			await rawCollection(database, collection).insertMany(documents.map((document) => ({ ...document })));
			return { snapshotPool, collection, streams };
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

		it('resumes after a crash after any step, to the same collection as a run without one', async () => {
			const corpus = snapshotCorpus();
			const clean = await seedSnapshots(corpus);
			await snapshotStore.migrate({ pools: [clean.snapshotPool] });
			const expected = await dump(clean.collection);
			expect(expected.documents.filter(({ latest }) => latest === null)).toEqual([]);
			expect(expected.registered).toEqual([{ kind: 'snapshots', schemaVersion: 2 }]);

			for (const crashAfter of SNAPSHOT_STEPS) {
				const { snapshotPool, collection, streams } = await seedSnapshots(corpus);
				migrationHooks.onStepComplete = (_, step) => {
					if (step === crashAfter) throw new Error(`crash after ${step}`);
				};
				await expect(snapshotStore.migrate({ pools: [snapshotPool] })).rejects.toThrow(`crash after ${crashAfter}`);
				migrationHooks.onStepComplete = undefined;

				await snapshotStore.migrate({ pools: [snapshotPool] });

				// Flags, indexes, registration, and no lease left
				expect(await dump(collection), `after a crash after ${crashAfter}`).toEqual(expected);
				expect((await snapshotStore.getLastEnvelope(streams.healthy, snapshotPool))?.metadata.version).toBe(3);
			}
		});

		it('keeps the flag of a snapshot that a 4.0 store appends while the flags are repaired', async () => {
			const { snapshotPool, collection, streams } = await seedSnapshots();
			// 3.x snapshot collections keep working under 4.0, with a warning
			vi.spyOn(snapshotStore['logger'], 'warn').mockImplementation(() => undefined);
			await snapshotStore.ensureCollection(snapshotPool);
			const findOne = Collection.prototype.findOne;
			migrationHooks.onStepComplete = (_, step) => {
				if (step === 'unset-null-latest') {
					// The repair reads the aggregation, then the first stream it repairs; the append lands in between
					vi.spyOn(Collection.prototype, 'findOne').mockImplementationOnce(async function (
						this: Collection,
						...args: Parameters<Collection['findOne']>
					) {
						await snapshotStore.appendSnapshot(streams.duplicate, 3, { balance: 3 }, snapshotPool);
						return findOne.apply(this, args as never);
					} as never);
				}
			};

			await expect(reportOf(snapshotStore.migrate({ pools: [snapshotPool] }))).resolves.toMatchObject({
				action: 'migrate',
			});

			expect(await flags(collection)).toEqual(
				Object.values(streams)
					.map((stream) => [
						stream.streamId,
						stream === streams.healthy || stream === streams.duplicate ? 3 : 2,
						`latest#${stream.streamId}`,
					])
					.sort(([x], [y]) => (String(x) < String(y) ? -1 : 1)),
			);
		});

		it('drops the 3.x latest index first when the server refuses a second index on its key', async () => {
			const { snapshotPool, collection } = await seedSnapshots();
			const createIndex = vi
				.spyOn(Collection.prototype, 'createIndex')
				.mockRejectedValueOnce(
					new MongoServerError({ code: 85, codeName: 'IndexOptionsConflict', errmsg: 'an index with this key exists' }),
				);

			const report = await reportOf(snapshotStore.migrate({ pools: [snapshotPool] }));

			expect(report.steps.every(({ status }) => status === 'done')).toBe(true);
			expect(createIndex).toHaveBeenCalledTimes(2);
			expect((await rawCollection(database, collection).indexes()).map(({ name }) => name)).toEqual([
				'_id_',
				'streamId_1_version_1',
				'latest_unique',
			]);
		});
	});
});
