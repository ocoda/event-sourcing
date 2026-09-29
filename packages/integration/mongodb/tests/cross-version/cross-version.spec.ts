import { createHash, randomUUID } from 'node:crypto';
import {
	type EventEnvelope,
	EventStoreSchemaException,
	EventStoreVersionConflictException,
	type MigrationReport,
	SnapshotCollection,
} from '@ocoda/event-sourcing';
import type { MongoDBEventStore, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import {
	MongoDBEventStore as EventStoreDriver,
	MongoDBSnapshotStore as SnapshotStoreDriver,
} from '@ocoda/event-sourcing-mongodb';
import {
	Account,
	type EncodedValue,
	type ManifestEventPool,
	NoteAdded,
	collect,
	createCrossVersionEventMap,
	crossVersionEventStream,
	crossVersionSnapshotStream,
	encodeEventEnvelope,
	encodeSnapshotEnvelope,
	encodeValue,
	expectCompleteCorpus,
	expectWriterTimeZone,
	loadCrossVersionManifest,
	poolOf,
} from '@ocoda/event-sourcing-testing/cross-version';
import { BSON, type Db, type Document, MongoClient } from 'mongodb';
import { CATALOG, rawCollection } from '../support/catalog.js';
import { createEventStore, createSnapshotStore } from '../support/stores.js';

// The published 3.0.2 packages wrote a corpus into a database of its own (fixtures/cross-version/v3/writer.mjs) and
// recorded what 3.0.2 read back. This driver refuses the 3.x collections, migrates them with migrate() (ADR 0002 §6,
// plan §8.4), and then reads the same data, in 3.x's order, with global positions. Afterwards a 3.0.2 append must fail
// (tests/cross-version/cross-version.json). Run through `pnpm test:cross-version --database mongodb`, once per
// topology.
const manifest = loadCrossVersionManifest();
const url = process.env.XV_MONGODB_URL;
if (!url) {
	throw new Error('XV_MONGODB_URL is not set: run the cross-version specs through scripts/test-cross-version.mjs');
}
const config = { url };
const topology = process.env.XV_TOPOLOGY ?? 'standalone';

/** The metadata fields that 3.x envelopes don't have. */
const V4_FIELDS = ['globalPosition', 'headers', 'eventVersion'];

/**
 * An encoded value without the fields that are `undefined` (3.x read absent metadata as `undefined`, 4.x leaves it
 * out) and, in the metadata of an envelope, without the fields 3.x didn't have.
 */
const withoutAbsent = (value: EncodedValue, drop: string[] = []): EncodedValue => {
	if (value === null || typeof value !== 'object' || !('fields' in value)) {
		return value;
	}
	return {
		...value,
		fields: Object.fromEntries(
			Object.entries(value.fields).filter(
				([key, field]) =>
					!drop.includes(key) && !(field !== null && typeof field === 'object' && '$undefined' in field),
			),
		),
	};
};

const comparable = (envelope: { event: string; payload: EncodedValue; metadata: EncodedValue }) => ({
	...envelope,
	metadata: withoutAbsent(envelope.metadata, V4_FIELDS),
});

const rowKey = ({ eventId, aggregateId, version }: { eventId: string; aggregateId: string; version: number }) =>
	`${eventId} ${aggregateId} ${version}`;

/**
 * The order the migration numbers a pool in (ADR 0001 D33): the rank `r` in the order 3.x read all events in (by
 * `eventDate, _id`; `_id` is unique, so there are no ties), and per stream the running maximum `key` of `r` by version;
 * the positions follow `(key, version)`.
 */
const expectedOrder = (pool: ManifestEventPool): string[] => {
	const streamOf = new Map(pool.written.map((row) => [`${row.aggregateId} ${row.version}`, row.streamId]));
	const byStream = new Map<string, { row: string; version: number; rank: number }[]>();
	pool.legacyAllOrder.forEach((entry, rank) => {
		const streamId = streamOf.get(`${entry.aggregateId} ${entry.version}`) as string;
		expect(streamId, `${rowKey(entry)} was written`).toBeDefined();
		byStream.set(streamId, [...(byStream.get(streamId) ?? []), { row: rowKey(entry), version: entry.version, rank }]);
	});
	const keyed: { key: number; version: number; row: string }[] = [];
	for (const rows of byStream.values()) {
		let key = -1;
		for (const { row, version, rank } of rows.sort((a, b) => a.version - b.version)) {
			key = Math.max(key, rank);
			keyed.push({ key, version, row });
		}
	}
	return keyed.sort((a, b) => a.key - b.key || a.version - b.version).map(({ row }) => row);
};

/** The 3.x indexes of a collection whose key has the field, as the writer recorded them. */
const legacyIndexesOf = (collection: string, field: string) =>
	((manifest.schema as { indexes: Record<string, { name: string; key: Document }[]> }).indexes[collection] ?? [])
		.filter(({ key }) => Object.hasOwn(key, field))
		.map(({ name }) => name);

describe(`MongoDB (${topology}) migrates the 3.0.2 corpus to schema v2 and reads it as 3.0.2 did`, () => {
	let client: MongoClient;
	let database: Db;
	let eventStore: MongoDBEventStore;
	let snapshotStore: MongoDBSnapshotStore;
	/** The positions each event pool had before the 4.x appends of the specs. */
	const counts = new Map<string, number>();

	/** Every collection of the namespace, with its options, indexes and a checksum of its documents. */
	const dumpNamespace = async () => {
		const collections = (await database.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name));
		const result: Record<string, unknown> = {};
		for (const { name, options } of collections as { name: string; options?: Document }[]) {
			const indexes = await database.collection(name).indexes();
			const documents = await database.collection(name).find({}, { promoteLongs: false }).sort({ _id: 1 }).toArray();
			const checksum = createHash('sha256')
				.update(BSON.EJSON.stringify(documents, { relaxed: false }))
				.digest('hex');
			result[name] = { options, indexes, count: documents.length, checksum };
		}
		return result;
	};

	const collectionReport = (report: MigrationReport, name: string) => {
		const collection = report.collections.find((candidate) => candidate.name === name);
		expect(collection, `${name} is in the report`).toBeDefined();
		return collection as MigrationReport['collections'][number];
	};

	beforeAll(async () => {
		expectWriterTimeZone(manifest);
		expectCompleteCorpus(manifest);
		client = await new MongoClient(url).connect();
		database = client.db();
		eventStore = createEventStore(config, createCrossVersionEventMap()).store;
		snapshotStore = createSnapshotStore(config);
		await Promise.all([eventStore.connect(), snapshotStore.connect()]);
	});

	afterAll(async () => {
		await Promise.all([eventStore?.disconnect(), snapshotStore?.disconnect(), client?.close()]);
	});

	it('claims the capabilities of the topology', () => {
		expect(eventStore.capabilities).toEqual(
			topology === 'replica-set'
				? { atomicAppend: true, headers: true, globalOrder: 'gap-safe' }
				: { atomicAppend: false, headers: true, globalOrder: 'best-effort' },
		);
	});

	it('refuses every 3.x event collection until it is migrated', async () => {
		for (const pool of manifest.eventPools) {
			await expect(eventStore.ensureCollection(poolOf(pool.pool)), `${pool.collection}`).rejects.toMatchObject({
				name: EventStoreSchemaException.name,
				collection: pool.collection,
				found: 'v1',
			});
		}
	});

	it('reports every pool, its gapped streams, non-canonical ids and 3.x indexes in a dry run, and writes nothing', async () => {
		const before = await dumpNamespace();

		const events = await EventStoreDriver.migrate(config, { dryRun: true });
		const snapshots = await SnapshotStoreDriver.migrate(config, { dryRun: true });

		expect(events).toMatchObject({ dryRun: true, environment: { topology } });
		expect(events.collections.map(({ name }) => name).sort()).toEqual(
			manifest.eventPools.map(({ collection }) => collection).sort(),
		);
		for (const pool of manifest.eventPools) {
			const collection = collectionReport(events, `${pool.collection}`);
			const nonCanonical = pool.written.filter(({ eventId }) => pool.nonCanonicalEventIds.includes(eventId)).length;
			expect(collection, `${pool.collection}`).toMatchObject({
				from: 'v1',
				action: 'migrate',
				blocking: [],
				rows: pool.written.length,
				nonCrockfordEventIds: nonCanonical,
				droppedIndexes: legacyIndexesOf(pool.collection, 'eventDate'),
			});
			expect(collection.gappedStreams.total).toBe(pool.gappedStreams.length);
			expect(collection.gappedStreams.sample.map(({ streamId }) => streamId)).toEqual(
				expect.arrayContaining(pool.gappedStreams),
			);
			// D35: the numbering key per collection, by its ids
			expect(collection.steps.find(({ name }) => name === 'number')?.statement, `${pool.collection}`).toContain(
				nonCanonical > 0 ? "$concat: ['$eventDate', '#', '$_id']" : 'sortBy: { _id: 1 }',
			);
		}
		// The fixture has both numbering paths: the default pool has non-canonical ids, the others don't
		expect(manifest.eventPools.filter(({ nonCanonicalEventIds }) => nonCanonicalEventIds.length > 0)).toHaveLength(1);

		expect(snapshots.collections.map(({ name }) => name).sort()).toEqual(
			manifest.snapshotPools.map(({ collection }) => collection).sort(),
		);
		for (const pool of manifest.snapshotPools) {
			const collection = collectionReport(snapshots, `${pool.collection}`);
			expect(collection, `${pool.collection}`).toMatchObject({
				from: 'v1',
				action: 'migrate',
				blocking: [],
				rows: pool.written.length,
				droppedIndexes: legacyIndexesOf(pool.collection, 'latest'),
			});
			expect(collection.snapshotFlags?.duplicateLatest).toBe(pool.duplicateLatest.length);
			expect(collection.snapshotFlags?.missingLatest).toBe(pool.missingLatest.length);
		}

		expect(await dumpNamespace()).toEqual(before);
	});

	it('migrates the events, then the snapshots, and skips them on a second run', async () => {
		for (const pool of manifest.eventPools) {
			counts.set(pool.collection, pool.written.length);
		}
		const events = await EventStoreDriver.migrate(config);
		const snapshots = await SnapshotStoreDriver.migrate(config);

		for (const collection of [...events.collections, ...snapshots.collections]) {
			expect(collection.action, `${collection.name}`).toBe('migrate');
			expect(
				collection.steps.map(({ status }) => status),
				`${collection.name}`,
			).not.toContain('pending');
			expect(collection.blocking, `${collection.name}`).toEqual([]);
		}

		const again = [
			...(await EventStoreDriver.migrate(config)).collections,
			...(await SnapshotStoreDriver.migrate(config)).collections,
		];
		expect(again.map(({ name, from, action }) => ({ name, from, action }))).toEqual(
			[...events.collections, ...snapshots.collections].map(({ name }) => ({ name, from: 'v2', action: 'skip' })),
		);

		// Fenced: a 3.x-shaped insert fails validation, and no event keeps its 3.x eventDate
		const [pool] = manifest.eventPools;
		await expect(
			rawCollection(database, `${pool.collection}`).insertOne({ _id: randomUUID(), streamId: 'xv', version: 1 }),
		).rejects.toMatchObject({ code: 121 });
		for (const { collection } of manifest.eventPools) {
			expect(await rawCollection(database, collection).countDocuments({ eventDate: { $exists: true } })).toBe(0);
			expect(
				(await rawCollection(database, collection).indexes()).filter(({ key }) => Object.hasOwn(key, 'eventDate')),
			).toEqual([]);
		}
	});

	it('lists the corpus collections from the catalog', async () => {
		await Promise.all(manifest.eventPools.map(({ pool }) => eventStore.ensureCollection(poolOf(pool))));
		await Promise.all(manifest.snapshotPools.map(({ pool }) => snapshotStore.ensureCollection(poolOf(pool))));

		expect((await collect(eventStore.listCollections())).sort()).toEqual(
			manifest.eventPools.map(({ collection }) => collection).sort(),
		);
		expect((await collect(snapshotStore.listCollections())).sort()).toEqual(
			manifest.snapshotPools.map(({ collection }) => collection).sort(),
		);
		for (const { collection } of manifest.eventPools) {
			expect(await rawCollection(database, CATALOG).findOne({ _id: collection })).toMatchObject({
				kind: 'events',
				schemaVersion: 2,
				lastPosition: counts.get(collection),
			});
		}
	});

	describe.each(manifest.eventPools)('$collection', (pool) => {
		let read: EventEnvelope[];

		beforeAll(async () => {
			read = await collect(eventStore.readAll({ pool: poolOf(pool.pool) }));
		});

		it('reads the pool in 3.x order, from position 1, with every stream in version order', async () => {
			expect(read.map(({ metadata }) => metadata.globalPosition)).toEqual(read.map((_, index) => BigInt(index + 1)));
			expect(read.map(({ metadata }) => rowKey({ ...metadata, eventId: metadata.eventId.value }))).toEqual(
				expectedOrder(pool),
			);

			// D33: the streams that 3.x listed out of version order are in version order now
			const versionsOf = (aggregateId: string) =>
				read.filter(({ metadata }) => metadata.aggregateId === aggregateId).map(({ metadata }) => metadata.version);
			for (const streamId of [...pool.invertedStreams, ...pool.outOfOrderStreams]) {
				const stream = pool.streams.find((candidate) => candidate.streamId === streamId);
				expect(stream, `${streamId}`).toBeDefined();
				const versions = versionsOf(stream?.aggregateId as string);
				expect(versions, `${streamId}`).toEqual([...versions].sort((a, b) => a - b));
			}
			for (const stream of pool.streams) {
				const versions = versionsOf(stream.aggregateId);
				expect(versions, `${stream.streamId}`).toEqual([...versions].sort((a, b) => a - b));
			}

			// The non-canonical ids are read back as they were written
			const ids = new Set(read.map(({ metadata }) => metadata.eventId.value));
			for (const eventId of pool.nonCanonicalEventIds) {
				expect(ids.has(eventId), `${eventId}`).toBe(true);
			}
		});

		it('returns every stream as 3.0.2 did, to the millisecond, with the positions of readAll', async () => {
			const positionOf = new Map(
				read.map(({ metadata }) => [rowKey({ ...metadata, eventId: metadata.eventId.value }), metadata.globalPosition]),
			);
			for (const stream of pool.streams) {
				const eventStream = crossVersionEventStream(stream);
				const envelopes = await collect(eventStore.getEnvelopes(eventStream, { pool: poolOf(pool.pool) }));
				expect
					.soft(
						envelopes.map((envelope) => comparable(encodeEventEnvelope(envelope))),
						`getEnvelopes(${stream.streamId})`,
					)
					.toEqual(stream.envelopes.map(comparable));
				for (const { metadata } of envelopes) {
					expect
						.soft(metadata.globalPosition)
						.toBe(positionOf.get(rowKey({ ...metadata, eventId: metadata.eventId.value })));
				}

				const events = await collect(eventStore.getEvents(eventStream, { pool: poolOf(pool.pool) }));
				expect.soft(events.map(encodeValue), `getEvents(${stream.streamId})`).toEqual(stream.events);
			}
		});

		it('conflicts on a gapped stream with its actual version', async () => {
			for (const streamId of pool.gappedStreams) {
				const stream = pool.streams.find((candidate) => candidate.streamId === streamId);
				expect(stream, `${streamId}`).toBeDefined();
				const events = stream?.envelopes.length ?? 0;
				const actual = Math.max(
					...(stream?.envelopes ?? []).map(({ metadata }) =>
						Number((metadata as unknown as { fields: { version: number } }).fields.version),
					),
				);
				expect(actual).toBeGreaterThan(events);
				await expect(
					eventStore.appendEvents(crossVersionEventStream(stream as never), [new NoteAdded('after a gap')], {
						expectedVersion: events,
						pool: poolOf(pool.pool),
					}),
				).rejects.toMatchObject({
					name: EventStoreVersionConflictException.name,
					expectedVersion: events,
					actualVersion: actual,
				});
			}
		});

		it('appends after the 3.x events at the next position, to an existing and to a new stream', async () => {
			const stream = pool.streams.find(({ streamId }) => !pool.gappedStreams.includes(streamId));
			expect(stream).toBeDefined();
			const count = counts.get(pool.collection) as number;
			const version = stream?.envelopes.length as number;

			const [appended] = await eventStore.appendEvents(
				crossVersionEventStream(stream as never),
				[new NoteAdded('appended by 4.x')],
				{ expectedVersion: version, pool: poolOf(pool.pool) },
			);
			expect(appended.metadata).toMatchObject({ version: version + 1, globalPosition: BigInt(count + 1) });

			const fresh = crossVersionEventStream({ aggregate: 'account', aggregateId: randomUUID() });
			const [created] = await eventStore.appendEvents(fresh, [new NoteAdded('a new stream')], {
				expectedVersion: 0,
				pool: poolOf(pool.pool),
			});
			expect(created.metadata.globalPosition).toBe(BigInt(count + 2));
			const tail = await collect(eventStore.readAll({ pool: poolOf(pool.pool), fromPosition: BigInt(count + 1) }));
			expect(tail.map(({ metadata }) => metadata.eventId.value)).toEqual([
				appended.metadata.eventId.value,
				created.metadata.eventId.value,
			]);
		});
	});

	describe.each(manifest.snapshotPools)('$collection', (pool) => {
		it('reads the highest version as the last snapshot, with the registeredOn 3.x wrote', async () => {
			for (const stream of pool.streams) {
				const snapshotStream = crossVersionSnapshotStream(stream);
				const envelopes = await collect(snapshotStore.getEnvelopes(snapshotStream, { pool: poolOf(pool.pool) }));
				const written = pool.written.filter(({ streamId }) => streamId === stream.streamId);
				expect(
					envelopes.map(({ metadata }) => metadata.version),
					`${stream.streamId}`,
				).toEqual(written.map(({ version }) => version).sort((a, b) => a - b));
				expect
					.soft(envelopes.map(encodeSnapshotEnvelope), `getEnvelopes(${stream.streamId})`)
					.toEqual(stream.envelopes);
				for (const { metadata } of envelopes) {
					const row = written.find(({ version }) => version === metadata.version);
					expect
						.soft(metadata.registeredOn.toISOString(), `${stream.streamId}@${metadata.version}`)
						.toBe(row?.registeredOn);
					expect.soft(metadata.snapshotId).toBe(row?.snapshotId);
				}

				const last = await snapshotStore.getLastEnvelope(snapshotStream, poolOf(pool.pool));
				expect
					.soft(encodeSnapshotEnvelope(last), `getLastEnvelope(${stream.streamId})`)
					.toEqual(encodeSnapshotEnvelope(envelopes.at(-1)));
			}
		});

		it('flags exactly the highest version of every stream, and enforces it with a unique index', async () => {
			const collection = SnapshotCollection.get(poolOf(pool.pool));
			const streams = await rawCollection(database, collection)
				.aggregate<{ _id: string; highest: number; flagged: number[]; nulls: number }>([
					{
						$group: {
							_id: '$streamId',
							highest: { $max: '$version' },
							flagged: { $push: { $cond: [{ $eq: [{ $type: '$latest' }, 'string'] }, '$version', '$$REMOVE'] } },
							nulls: { $sum: { $cond: [{ $eq: [{ $type: '$latest' }, 'null'] }, 1, 0] } },
						},
					},
				])
				.toArray();
			expect(streams.length).toBe(pool.streams.length);
			for (const stream of streams) {
				expect(stream, `${stream._id}`).toMatchObject({ flagged: [stream.highest], nulls: 0 });
			}
			const indexes = await rawCollection(database, collection).indexes();
			expect(indexes.map(({ name }) => name)).toEqual(['_id_', 'streamId_1_version_1', 'latest_unique']);
			expect(indexes.find(({ name }) => name === 'latest_unique')).toMatchObject({
				unique: true,
				partialFilterExpression: { latest: { $type: 'string' } },
			});

			// The latest snapshot of every account stream, in descending binary order of the aggregate ids
			const accounts = pool.streams.filter(({ aggregate }) => aggregate === 'account');
			const latest = await collect(snapshotStore.getLastEnvelopesForAggregate(Account, { pool: poolOf(pool.pool) }));
			expect(latest.map(({ metadata }) => metadata.aggregateId)).toEqual(
				accounts.map(({ aggregateId }) => aggregateId).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)),
			);
			for (const { metadata } of latest) {
				const highest = Math.max(
					...pool.written
						.filter(({ aggregateId }) => aggregateId === metadata.aggregateId)
						.map(({ version }) => version),
				);
				expect(metadata.version, `${metadata.aggregateId}`).toBe(highest);
			}
		});
	});
});
