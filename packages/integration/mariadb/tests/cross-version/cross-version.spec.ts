import { randomUUID } from 'node:crypto';
import {
	type EventEnvelope,
	EventStoreSchemaException,
	EventStoreVersionConflictException,
	type MigrationReport,
	SnapshotCollection,
} from '@ocoda/event-sourcing';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import {
	type EncodedValue,
	type ManifestEventPool,
	type ManifestEventStream,
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
import { mariadbTestConfig } from '@ocoda/event-sourcing-testing/unit';
import { type Pool, createPool } from 'mariadb';
import { createEventStore, createSnapshotStore } from '../support/stores.js';

// The published 3.0.2 packages wrote a corpus into a database of its own (fixtures/cross-version/v3/writer.mjs), in
// TZ=America/New_York, and recorded what 3.0.2 read back. This driver refuses the 3.x tables, migrates them with
// migrate() (ADR 0002 §6, plan §8.4), and then reads the same data: in 3.x's order, with global positions, and with
// occurredOn restored to the millisecond from the event ids. Afterwards a 3.0.2 append must fail
// (tests/cross-version/cross-version.json). Run through `pnpm test:cross-version --database mariadb`.
const manifest = loadCrossVersionManifest();
const config = { ...mariadbTestConfig(), database: manifest.namespace };

/** The metadata fields that 3.x envelopes don't have, and occurredOn, which 3.x read to the second. */
const NOT_COMPARED = ['globalPosition', 'headers', 'eventVersion', 'occurredOn'];

/**
 * An encoded value without the fields that are `undefined` (3.x set `correlationId: undefined`, 4.x leaves it out) and
 * without the given fields.
 */
const without = (value: EncodedValue, drop: string[] = []): EncodedValue => {
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
	metadata: without(envelope.metadata, NOT_COMPARED),
});

const fieldOf = (value: EncodedValue, field: string): EncodedValue | undefined =>
	value !== null && typeof value === 'object' && 'fields' in value ? value.fields[field] : undefined;

const dateOf = (value: EncodedValue | undefined): number => {
	if (value === null || typeof value !== 'object' || !('$date' in value) || value.$date === null) {
		throw new Error(`not a date: ${JSON.stringify(value)}`);
	}
	return Date.parse(value.$date);
};

const rowKey = ({ eventId, aggregateId, version }: { eventId: string; aggregateId: string; version: number }) =>
	`${eventId} ${aggregateId} ${version}`;

/** Binary order, like the `utf8mb4_bin` columns of schema v2. */
const compareBinary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The instant schema v2 reads for a 3.x `TIMESTAMP` that 3.x read as `instant` in the writer's time zone: the 3.x
 * connector wrote the wall time of the process (New York), the server kept it as UTC, and the migration keeps the wall
 * time as UTC. Snapshots have no id with a time to restore it from (the migration warns about it).
 */
const asStoredWallTime = (instant: number) => instant - new Date(instant).getTimezoneOffset() * 60_000;

/** The written rows of a stream, by its exact (binary) stream id: schema v2 splits ids that differ in case only. */
const writtenOf = (pool: ManifestEventPool, streamId: string) =>
	pool.written.filter((row) => row.streamId === streamId);

/** The envelopes 3.x read for a stream that are the stream's under schema v2 (a case-variant twin has the others). */
const expectedEnvelopesOf = (pool: ManifestEventPool, stream: ManifestEventStream) => {
	const versions = new Set(writtenOf(pool, stream.streamId).map(({ version }) => version));
	return stream.envelopes.filter(({ metadata }) => versions.has(Number(fieldOf(metadata, 'version'))));
};

/** Streams, by exact stream id, whose versions don't run from 1 without gaps. */
const gappedStreamsOf = (pool: ManifestEventPool): string[] => {
	const versions = new Map<string, number[]>();
	for (const { streamId, version } of pool.written) {
		versions.set(streamId, [...(versions.get(streamId) ?? []), version]);
	}
	return [...versions]
		.filter(([, list]) => Math.min(...list) !== 1 || Math.max(...list) !== list.length)
		.map(([streamId]) => streamId)
		.sort(compareBinary);
};

/**
 * The order the migration numbers a pool in (ADR 0001 D33): the rank `r` in 3.x's order (`getAllEnvelopes`: event
 * date, event id; rows that share an event id by stream id and version), and per stream the running maximum `key` of
 * `r` by version; the positions follow `(key, version)`. Streams are grouped as the 3.x table compares their ids (case
 * insensitive), like the migration's window.
 */
const expectedOrder = (pool: ManifestEventPool): string[] => {
	const streamOf = new Map(pool.written.map((row) => [`${row.aggregateId} ${row.version}`, row.streamId]));
	const entries = pool.legacyAllOrder.map((entry) => ({
		...entry,
		streamId: streamOf.get(`${entry.aggregateId} ${entry.version}`) as string,
	}));
	expect(
		entries.every(({ streamId }) => streamId !== undefined),
		'every entry was written',
	).toBe(true);

	const ranked: typeof entries = [];
	for (let index = 0; index < entries.length;) {
		let end = index + 1;
		while (end < entries.length && entries[end].eventId === entries[index].eventId) end++;
		// The stream ids of the corpus that share event ids are lower-case: the table's collation orders them in binary
		ranked.push(
			...entries.slice(index, end).sort((a, b) => compareBinary(a.streamId, b.streamId) || a.version - b.version),
		);
		index = end;
	}

	const byStream = new Map<string, { entry: (typeof ranked)[number]; rank: number }[]>();
	ranked.forEach((entry, rank) => {
		const stream = entry.streamId.toLowerCase();
		byStream.set(stream, [...(byStream.get(stream) ?? []), { entry, rank }]);
	});
	const keyed: { key: number; version: number; row: string }[] = [];
	for (const rows of byStream.values()) {
		let key = -1;
		for (const { entry, rank } of rows.sort((a, b) => a.entry.version - b.entry.version)) {
			key = Math.max(key, rank);
			keyed.push({ key, version: entry.version, row: rowKey(entry) });
		}
	}
	return keyed.sort((a, b) => a.key - b.key || a.version - b.version).map(({ row }) => row);
};

const collectionReport = (report: MigrationReport, name: string) => {
	const collection = report.collections.find((candidate) => candidate.name === name);
	expect(collection, `${name} is in the report`).toBeDefined();
	return collection as MigrationReport['collections'][number];
};

describe('MariaDB migrates the 3.0.2 corpus to schema v2 and reads it as 3.0.2 did', () => {
	let db: Pool;
	let eventStore: MariaDBEventStore;
	let snapshotStore: MariaDBSnapshotStore;

	/** Every table of the namespace, with its DDL and a checksum of its rows. */
	const dumpNamespace = async () => {
		const tables = await db.query<{ TABLE_NAME: string }[]>(
			"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY BINARY TABLE_NAME",
		);
		const result: Record<string, unknown> = {};
		for (const { TABLE_NAME } of tables) {
			const [{ 'Create Table': ddl }] = await db.query<{ 'Create Table': string }[]>(
				`SHOW CREATE TABLE ${db.escapeId(TABLE_NAME)}`,
			);
			const [{ Checksum }] = await db.query<{ Checksum: bigint | number | null }[]>(
				`CHECKSUM TABLE ${db.escapeId(TABLE_NAME)}`,
			);
			result[TABLE_NAME] = { ddl, checksum: String(Checksum) };
		}
		return result;
	};

	beforeAll(async () => {
		expectWriterTimeZone(manifest);
		expectCompleteCorpus(manifest);
		db = createPool({ ...config, connectionLimit: 2 });
		eventStore = createEventStore(config, createCrossVersionEventMap()).store;
		snapshotStore = createSnapshotStore(config);
		await Promise.all([eventStore.connect(), snapshotStore.connect()]);
	});

	afterAll(async () => {
		await Promise.all([eventStore?.disconnect(), snapshotStore?.disconnect(), db?.end()]);
	});

	it('refuses every 3.x event table until it is migrated', async () => {
		// The writer created the legacy pool's tables with the pre-10.10 DDL: the migration must not let it fire
		expect(Object.values(manifest.legacyDdl ?? {}).join('\n')).toMatch(/ON UPDATE current_timestamp/i);
		expect(manifest.snapshotPools.some(({ registeredOnShiftDays }) => Boolean(registeredOnShiftDays))).toBe(true);
		for (const pool of manifest.eventPools) {
			await expect(eventStore.ensureCollection(poolOf(pool.pool)), `${pool.collection}`).rejects.toMatchObject({
				name: EventStoreSchemaException.name,
				collection: pool.collection,
				found: 'v1',
			});
		}
	});

	it('reports every pool, its gapped and case-variant streams, and the occurredOn repair in a dry run, and writes nothing', async () => {
		const before = await dumpNamespace();

		const events = await MariaDBEventStore.migrate(config, { dryRun: true });
		const snapshots = await MariaDBSnapshotStore.migrate(config, { dryRun: true });

		expect(events.collections.map(({ name }) => name).sort()).toEqual(
			manifest.eventPools.map(({ collection }) => collection).sort(),
		);
		for (const pool of manifest.eventPools) {
			const collection = collectionReport(events, pool.collection);
			const gapped = gappedStreamsOf(pool);
			expect(collection, `${pool.collection}`).toMatchObject({
				from: 'v1',
				action: 'migrate',
				blocking: [],
				rows: pool.written.length,
				duplicateEventIds: pool.duplicateEventIds.length,
				// 3.x's case-insensitive twins become separate streams
				caseVariantStreams: pool.caseVariantStreams.length > 0 ? 1 : 0,
				droppedIndexes: ['idx_event_date_id'],
				// Every event id holds the time 3.x set occurredOn from
				occurredOnRepair: expect.objectContaining({ kept: 0 }),
			});
			expect(collection.gappedStreams.total, `${pool.collection}`).toBe(gapped.length);
			expect(collection.gappedStreams.sample.map(({ streamId }) => streamId)).toEqual(gapped);
			expect(gapped).toEqual(expect.arrayContaining(pool.gappedStreams));
			const repair = collection.occurredOnRepair as NonNullable<typeof collection.occurredOnRepair>;
			expect(repair.exact + repair.precisionOnly + repair.tzShifted, `${pool.collection}`).toBe(pool.written.length);
			// Written in New York, stored as UTC: every row is shifted by the offset of its date
			expect(repair.tzShifted, `${pool.collection}`).toBe(pool.written.length);
			const nonCanonical = pool.written.filter(({ eventId }) => pool.nonCanonicalEventIds.includes(eventId)).length;
			expect(collection.nonCrockfordEventIds, `${pool.collection}: non-canonical ids`).toBe(nonCanonical);
		}
		expect(manifest.eventPools.some(({ caseVariantStreams }) => caseVariantStreams.length > 0)).toBe(true);

		expect(snapshots.collections.map(({ name }) => name).sort()).toEqual(
			manifest.snapshotPools.map(({ collection }) => collection).sort(),
		);
		for (const pool of manifest.snapshotPools) {
			const collection = collectionReport(snapshots, pool.collection);
			expect(collection, `${pool.collection}`).toMatchObject({
				from: 'v1',
				action: 'migrate',
				blocking: [],
				rows: pool.written.length,
				droppedIndexes: ['idx_aggregate_name_latest'],
			});
			expect(collection.snapshotFlags?.duplicateLatest).toBe(pool.duplicateLatest.length);
			expect(collection.snapshotFlags?.missingLatest).toBe(pool.missingLatest.length);
		}

		expect(await dumpNamespace()).toEqual(before);
	});

	it('migrates the events, then the snapshots, and skips them on a second run', async () => {
		const events = await MariaDBEventStore.migrate(config);
		const snapshots = await MariaDBSnapshotStore.migrate(config);

		for (const collection of [...events.collections, ...snapshots.collections]) {
			expect(collection.action, `${collection.name}`).toBe('migrate');
			expect(
				collection.steps.map(({ status }) => status),
				`${collection.name}`,
			).not.toContain('pending');
			expect(collection.blocking, `${collection.name}`).toEqual([]);
		}
		// 3.x wrote nothing during the migration
		expect(events.collections.flatMap(({ warnings }) => warnings).join('\n')).not.toMatch(/caught up/);

		const again = [
			...(await MariaDBEventStore.migrate(config)).collections,
			...(await MariaDBSnapshotStore.migrate(config)).collections,
		];
		expect(again.map(({ name, from, action }) => ({ name, from, action }))).toEqual(
			[...events.collections, ...snapshots.collections].map(({ name }) => ({ name, from: 'v2', action: 'skip' })),
		);

		// The 3.x tables are kept as backups, untouched
		for (const pool of manifest.eventPools) {
			const [{ rows }] = await db.query<{ rows: bigint }[]>(
				`SELECT COUNT(*) AS \`rows\` FROM ${db.escapeId(`${pool.collection}__es_v1`)}`,
			);
			expect(Number(rows), `${pool.collection}`).toBe(pool.written.length);
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
	});

	describe.each(manifest.eventPools)('$collection', (pool) => {
		let read: EventEnvelope[];

		beforeAll(async () => {
			read = await collect(eventStore.readAll({ pool: poolOf(pool.pool) }));
		});

		it('reads the pool in 3.x order, from position 1, with every stream in version order', () => {
			expect(read.map(({ metadata }) => metadata.globalPosition)).toEqual(read.map((_, index) => BigInt(index + 1)));
			expect(read.map(({ metadata }) => rowKey({ ...metadata, eventId: metadata.eventId.value }))).toEqual(
				expectedOrder(pool),
			);

			// D33: the streams that 3.x listed out of version order are in version order now
			const streamIdOf = new Map(pool.written.map((row) => [`${row.aggregateId} ${row.version}`, row.streamId]));
			const versions = new Map<string, number[]>();
			for (const { metadata } of read) {
				const streamId = streamIdOf.get(`${metadata.aggregateId} ${metadata.version}`) as string;
				versions.set(streamId, [...(versions.get(streamId) ?? []), metadata.version]);
			}
			for (const streamId of [...pool.invertedStreams, ...pool.outOfOrderStreams]) {
				expect(versions.get(streamId), `${streamId}`).toBeDefined();
			}
			for (const [streamId, list] of versions) {
				expect(list, `${streamId}`).toEqual([...list].sort((a, b) => a - b));
			}

			// The non-canonical ids are read back as they were written
			const ids = new Set(read.map(({ metadata }) => metadata.eventId.value));
			for (const eventId of pool.nonCanonicalEventIds) {
				expect(ids.has(eventId), `${eventId}`).toBe(true);
			}
		});

		it('restores occurredOn to the millisecond 3.x appended, also for the rows a New York process shifted', () => {
			const written = new Map(pool.written.map((row) => [`${row.aggregateId} ${row.version}`, row.occurredOn]));
			for (const { metadata } of read) {
				expect
					.soft(metadata.occurredOn.toISOString(), `${metadata.aggregateId}@${metadata.version}`)
					.toBe(written.get(`${metadata.aggregateId} ${metadata.version}`));
			}
		});

		it('returns every stream as 3.0.2 did, with the positions of readAll', async () => {
			const positionOf = new Map(
				read.map(({ metadata }) => [rowKey({ ...metadata, eventId: metadata.eventId.value }), metadata.globalPosition]),
			);
			for (const stream of pool.streams) {
				const eventStream = crossVersionEventStream(stream);
				const expected = expectedEnvelopesOf(pool, stream);
				const envelopes = await collect(eventStore.getEnvelopes(eventStream, { pool: poolOf(pool.pool) }));
				expect
					.soft(
						envelopes.map((envelope) => comparable(encodeEventEnvelope(envelope))),
						`getEnvelopes(${stream.streamId})`,
					)
					.toEqual(expected.map(comparable));
				// occurredOn is compared with what 3.x appended, to the millisecond, above: 3.x read it to the second, and an
				// hour off in the hour that New York repeats when it leaves daylight saving time
				for (const { metadata } of envelopes) {
					expect
						.soft(metadata.globalPosition)
						.toBe(positionOf.get(rowKey({ ...metadata, eventId: metadata.eventId.value })));
				}

				if (!pool.caseVariantStreams.includes(stream.streamId)) {
					const events = await collect(eventStore.getEvents(eventStream, { pool: poolOf(pool.pool) }));
					expect.soft(events.map(encodeValue), `getEvents(${stream.streamId})`).toEqual(stream.events);
				}
			}
		});

		it('conflicts on a gapped stream with its actual version', async () => {
			for (const streamId of pool.gappedStreams) {
				const stream = pool.streams.find((candidate) => candidate.streamId === streamId) as ManifestEventStream;
				expect(stream, `${streamId}`).toBeDefined();
				const rows = writtenOf(pool, streamId);
				await expect(
					eventStore.appendEvents(crossVersionEventStream(stream), [new NoteAdded('after a gap')], {
						expectedVersion: rows.length,
						pool: poolOf(pool.pool),
					}),
				).rejects.toMatchObject({
					name: EventStoreVersionConflictException.name,
					expectedVersion: rows.length,
					actualVersion: Math.max(...rows.map(({ version }) => version)),
				});
			}
		});

		it('appends after the 3.x events at the next position, to an existing and to a new stream', async () => {
			const stream = pool.streams.find(
				({ streamId }) => !pool.gappedStreams.includes(streamId) && !pool.caseVariantStreams.includes(streamId),
			) as ManifestEventStream;
			expect(stream).toBeDefined();
			const count = pool.written.length;
			const version = writtenOf(pool, stream.streamId).length;

			const [appended] = await eventStore.appendEvents(
				crossVersionEventStream(stream),
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
		});
	});

	describe.each(manifest.snapshotPools)('$collection', (pool) => {
		it('reads the highest version as the last snapshot, and registeredOn as the wall time 3.x stored', async () => {
			for (const stream of pool.streams) {
				const snapshotStream = crossVersionSnapshotStream(stream);
				const envelopes = await collect(snapshotStore.getEnvelopes(snapshotStream, { pool: poolOf(pool.pool) }));
				const written = pool.written.filter(({ streamId }) => streamId === stream.streamId);
				expect(
					envelopes.map(({ metadata }) => metadata.version),
					`${stream.streamId}`,
				).toEqual(written.map(({ version }) => version).sort((a, b) => a - b));
				for (const { metadata, payload } of envelopes) {
					const legacy = stream.envelopes.find(
						(envelope) => Number(fieldOf(envelope.metadata, 'version')) === metadata.version,
					);
					expect.soft(encodeValue(payload), `${stream.streamId}@${metadata.version}`).toEqual(legacy?.payload);
					expect
						.soft(metadata.snapshotId)
						.toBe(written.find(({ version }) => version === metadata.version)?.snapshotId);
					// The migration keeps the value 3.x stored (and 3.x read), which the legacy pool's ON UPDATE must not clobber
					expect
						.soft(metadata.registeredOn.getTime(), `${stream.streamId}@${metadata.version}`)
						.toBe(asStoredWallTime(dateOf(fieldOf(legacy?.metadata ?? null, 'registeredOn'))));
					if (pool.registeredOnShiftDays) {
						// The writer moved every registered_on of the legacy pool away from now: a clobbered one would be recent
						expect
							.soft(Math.abs(Date.now() - metadata.registeredOn.getTime()), `${stream.streamId}@${metadata.version}`)
							.toBeGreaterThan(12 * 60 * 60 * 1000);
					}
				}

				const last = await snapshotStore.getLastEnvelope(snapshotStream, poolOf(pool.pool));
				expect
					.soft(encodeSnapshotEnvelope(last), `getLastEnvelope(${stream.streamId})`)
					.toEqual(encodeSnapshotEnvelope(envelopes.at(-1)));
			}
		});

		it('flags exactly the highest version of every stream, and enforces it with a unique index', async () => {
			const table = db.escapeId(SnapshotCollection.get(poolOf(pool.pool)));
			const rows = await db.query<{ stream_id: string; flagged: bigint; highest: bigint }[]>(
				`SELECT s.stream_id, COUNT(s.latest) AS flagged,
					SUM(s.latest IS NOT NULL AND s.version = (SELECT MAX(version) FROM ${table} m WHERE m.stream_id = s.stream_id)) AS highest
				 FROM ${table} s GROUP BY s.stream_id`,
			);
			expect(rows.length).toBe(pool.streams.length);
			for (const row of rows) {
				expect({ flagged: Number(row.flagged), highest: Number(row.highest) }, `${row.stream_id}`).toEqual({
					flagged: 1,
					highest: 1,
				});
			}
			const [{ 'Create Table': ddl }] = await db.query<{ 'Create Table': string }[]>(`SHOW CREATE TABLE ${table}`);
			expect(ddl).toMatch(/UNIQUE KEY `ux_latest` \(`aggregate_name`,`latest`\)/);
			expect(ddl).not.toMatch(/ON UPDATE/i);
		});
	});
});
