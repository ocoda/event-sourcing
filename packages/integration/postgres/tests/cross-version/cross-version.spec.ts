import {
	type EventEnvelope,
	EventStoreSchemaException,
	EventStoreVersionConflictException,
	type MigrationReport,
	SnapshotCollection,
} from '@ocoda/event-sourcing';
import { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import {
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
import { postgresTestConfig } from '@ocoda/event-sourcing-testing/unit';
import { Pool, escapeIdentifier } from 'pg';
import { createEventStore, createSnapshotStore } from '../support/stores.js';

// The published 3.0.2 packages wrote a corpus into a schema of its own (fixtures/cross-version/v3/writer.mjs) and
// recorded what 3.0.2 read back. This driver refuses the 3.x tables, migrates them with migrate() (ADR 0002 §6, plan
// §8.4), and then reads the same data, in 3.x's order, with global positions. Afterwards a 3.0.2 append must fail
// (tests/cross-version/cross-version.json). Run through `pnpm test:cross-version --database postgres`.
const manifest = loadCrossVersionManifest();
const config = {
	...postgresTestConfig(),
	application_name: 'postgres-cross-version',
	options: `-c search_path=${manifest.namespace}`,
};

/** The metadata fields that 3.x envelopes don't have. */
const V4_FIELDS = ['globalPosition', 'headers', 'eventVersion'];

/**
 * An encoded value without the fields that are `undefined` (3.x set `correlationId: undefined`, 4.x leaves it out) and,
 * in the metadata of an envelope, without the fields 3.x didn't have.
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

describe('PostgreSQL migrates the 3.0.2 corpus to schema v2 and reads it as 3.0.2 did', () => {
	let db: Pool;
	let eventStore: PostgresEventStore;
	let snapshotStore: PostgresSnapshotStore;
	/** The positions each event pool had before the 4.x appends of the specs. */
	const counts = new Map<string, number>();

	/**
	 * Every table of the namespace, with its columns, indexes and a checksum of its rows.
	 */
	const dumpNamespace = async () => {
		const { rows: tables } = await db.query<{ name: string }>(
			'SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename COLLATE "C"',
		);
		const result: Record<string, unknown> = {};
		for (const { name } of tables) {
			const { rows: columns } = await db.query(
				`SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull FROM pg_attribute
				WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
				[escapeIdentifier(name)],
			);
			const { rows: indexes } = await db.query(
				'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY indexname COLLATE "C"',
				[name],
			);
			const {
				rows: [{ checksum }],
			} = await db.query(
				`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text COLLATE "C"), '')) AS checksum FROM ${escapeIdentifier(name)} t`,
			);
			result[name] = { columns, indexes, checksum };
		}
		return result;
	};

	/**
	 * The 3.x secondary indexes of a table, by their columns, as the writer recorded them.
	 */
	const legacyIndexesOf = (collection: string, columns: string) =>
		((manifest.schema as { indexes: Record<string, { name: string; definition: string }[]> }).indexes[collection] ?? [])
			.filter(({ definition }) => definition.includes(`(${columns})`))
			.map(({ name }) => name);

	/**
	 * The order the migration numbers a pool in (ADR 0001 D33): the rank `r` in 3.x's order (`getAllEnvelopes`, where
	 * rows that share an event id come by stream id and version), and per stream the running maximum `key` of `r` by
	 * version; the positions follow `(key, version)`.
	 */
	const expectedOrder = async (pool: ManifestEventPool): Promise<string[]> => {
		const streamOf = new Map(pool.written.map((row) => [`${row.aggregateId} ${row.version}`, row.streamId]));
		const entries = pool.legacyAllOrder.map((entry) => ({
			...entry,
			streamId: streamOf.get(`${entry.aggregateId} ${entry.version}`) as string,
		}));
		expect(
			entries.every(({ streamId }) => streamId !== undefined),
			'every entry was written',
		).toBe(true);

		// Rows that share an event id: by stream id (with the collation of the database) and version
		const ranked: typeof entries = [];
		for (let index = 0; index < entries.length;) {
			let end = index + 1;
			while (end < entries.length && entries[end].eventId === entries[index].eventId) end++;
			const group = entries.slice(index, end);
			if (group.length > 1) {
				const { rows } = await db.query<{ s: string; v: number }>(
					'SELECT s, v FROM unnest($1::text[], $2::int[]) AS u(s, v) ORDER BY s, v',
					[group.map(({ streamId }) => streamId), group.map(({ version }) => version)],
				);
				ranked.push(
					...rows.map(
						({ s, v }) =>
							group.find(({ streamId, version }) => streamId === s && version === v) as (typeof group)[number],
					),
				);
			} else {
				ranked.push(group[0]);
			}
			index = end;
		}

		const byStream = new Map<string, { entry: (typeof ranked)[number]; rank: number }[]>();
		ranked.forEach((entry, rank) =>
			byStream.set(entry.streamId, [...(byStream.get(entry.streamId) ?? []), { entry, rank }]),
		);
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

	beforeAll(async () => {
		expectWriterTimeZone(manifest);
		expectCompleteCorpus(manifest);
		db = new Pool(config);
		eventStore = createEventStore(config, createCrossVersionEventMap()).store;
		snapshotStore = createSnapshotStore(config);
		await Promise.all([eventStore.connect(), snapshotStore.connect()]);
	});

	afterAll(async () => {
		await Promise.all([eventStore?.disconnect(), snapshotStore?.disconnect(), db?.end()]);
	});

	it('refuses every 3.x event table until it is migrated', async () => {
		for (const pool of manifest.eventPools) {
			await expect.soft(eventStore.ensureCollection(poolOf(pool.pool)), pool.collection).rejects.toMatchObject({
				name: EventStoreSchemaException.name,
				collection: pool.collection,
				found: 'v1',
			});
		}
	});

	it('reports every pool, its gapped streams, duplicate ids and index variants in a dry run, and writes nothing', async () => {
		const before = await dumpNamespace();

		const events = await PostgresEventStore.migrate(config, { dryRun: true });
		const snapshots = await PostgresSnapshotStore.migrate(config, {
			dryRun: true,
			legacyTimeZone: manifest.writerTimeZone,
		});

		expect(events.collections.map(({ name }) => name).sort()).toEqual(
			manifest.eventPools.map(({ collection }) => collection).sort(),
		);
		for (const pool of manifest.eventPools) {
			const collection = collectionReport(events, pool.collection);
			expect.soft(collection, pool.collection).toMatchObject({
				from: 'v1',
				action: 'migrate',
				blocking: [],
				rows: pool.written.length,
				duplicateEventIds: pool.duplicateEventIds.length,
				droppedIndexes: legacyIndexesOf(pool.collection, 'event_date, event_id'),
			});
			expect(collection.gappedStreams.sample.map(({ streamId }) => streamId)).toEqual(
				expect.arrayContaining(pool.gappedStreams),
			);
			expect(collection.gappedStreams.total).toBe(pool.gappedStreams.length);
			const nonCanonical = pool.written.filter(({ eventId }) => pool.nonCanonicalEventIds.includes(eventId)).length;
			expect(collection.nonCrockfordEventIds, `${pool.collection}: non-canonical ids`).toBe(nonCanonical);
		}
		// The index variants of the fixture: 3.0.0's fixed name, a pool without index, the derived names
		expect(
			manifest.eventPools.some(({ collection }) =>
				legacyIndexesOf(collection, 'event_date, event_id').includes('idx_event_date_id'),
			),
		).toBe(true);
		expect(
			manifest.eventPools.some(({ collection }) => legacyIndexesOf(collection, 'event_date, event_id').length === 0),
		).toBe(true);

		for (const pool of manifest.snapshotPools) {
			const collection = collectionReport(snapshots, pool.collection);
			expect.soft(collection, pool.collection).toMatchObject({
				from: 'v1',
				action: 'migrate',
				blocking: [],
				droppedIndexes: legacyIndexesOf(pool.collection, 'aggregate_name, latest'),
			});
			expect(collection.snapshotFlags?.duplicateLatest).toBe(pool.duplicateLatest.length);
			expect(collection.snapshotFlags?.missingLatest).toBeGreaterThanOrEqual(pool.missingLatest.length);
			expect(collection.steps.find(({ name }) => name === 'convert-columns')?.statement).toContain(
				`AT TIME ZONE '${manifest.writerTimeZone}'`,
			);
		}

		expect(await dumpNamespace()).toEqual(before);
	});

	it('migrates the events, then the snapshots, and skips them on a second run', async () => {
		for (const pool of manifest.eventPools) {
			counts.set(pool.collection, pool.written.length);
		}
		const events = await PostgresEventStore.migrate(config);
		const snapshots = await PostgresSnapshotStore.migrate(config, { legacyTimeZone: manifest.writerTimeZone });

		for (const collection of [...events.collections, ...snapshots.collections]) {
			expect.soft(collection.action, collection.name).toBe('migrate');
			expect
				.soft(
					collection.steps.map(({ status }) => status),
					collection.name,
				)
				.not.toContain('pending');
			expect.soft(collection.blocking, collection.name).toEqual([]);
		}

		const again = [
			...(await PostgresEventStore.migrate(config)).collections,
			...(await PostgresSnapshotStore.migrate(config, { legacyTimeZone: manifest.writerTimeZone })).collections,
		];
		expect(again.map(({ name, from, action }) => ({ name, from, action }))).toEqual(
			[...events.collections, ...snapshots.collections].map(({ name }) => ({ name, from: 'v2', action: 'skip' })),
		);
	});

	it('has every case of the fixture in the corpus', () => {
		// D33 (W1): without these, the checks of the event pools below would pass on empty lists
		for (const field of ['invertedStreams', 'outOfOrderStreams', 'nonCanonicalEventIds', 'gappedStreams'] as const) {
			expect
				.soft(
					manifest.eventPools.some((pool) => pool[field].length > 0),
					field,
				)
				.toBe(true);
		}
		expect.soft(manifest.snapshotPools.some(({ duplicateLatest }) => duplicateLatest.length > 0)).toBe(true);
		expect.soft(manifest.snapshotPools.some(({ missingLatest }) => missingLatest.length > 0)).toBe(true);
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

		it('reads the pool in 3.x order, from position 1, with every stream in version order', async () => {
			expect(read.map(({ metadata }) => metadata.globalPosition)).toEqual(read.map((_, index) => BigInt(index + 1)));
			expect(read.map(({ metadata }) => rowKey({ ...metadata, eventId: metadata.eventId.value }))).toEqual(
				await expectedOrder(pool),
			);

			// D33: the streams that 3.x listed out of version order are in version order now
			const versionsOf = (aggregateId: string) =>
				read.filter(({ metadata }) => metadata.aggregateId === aggregateId).map(({ metadata }) => metadata.version);
			for (const streamId of [...pool.invertedStreams, ...pool.outOfOrderStreams]) {
				const stream = pool.streams.find((candidate) => candidate.streamId === streamId);
				expect.soft(stream, streamId).toBeDefined();
				const versions = versionsOf(stream?.aggregateId as string);
				expect.soft(versions, streamId).toEqual([...versions].sort((a, b) => a - b));
			}
			for (const stream of pool.streams) {
				const versions = versionsOf(stream.aggregateId);
				expect.soft(versions, stream.streamId).toEqual([...versions].sort((a, b) => a - b));
			}

			// The non-canonical ids are read back as they were written
			const ids = new Set(read.map(({ metadata }) => metadata.eventId.value));
			for (const eventId of pool.nonCanonicalEventIds) {
				expect.soft(ids.has(eventId), eventId).toBe(true);
			}
		});

		it('returns every stream as 3.0.2 did, with the positions of readAll', async () => {
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
				expect.soft(stream, streamId).toBeDefined();
				const versions = stream?.envelopes.map(({ metadata }) => withoutAbsent(metadata)) ?? [];
				const actual = Math.max(
					...(stream?.envelopes ?? []).map(({ metadata }) =>
						Number((metadata as unknown as { fields: { version: number } }).fields.version),
					),
				);
				await expect(
					eventStore.appendEvents(crossVersionEventStream(stream as never), [new NoteAdded('after a gap')], {
						expectedVersion: versions.length,
						pool: poolOf(pool.pool),
					}),
				).rejects.toMatchObject({
					name: EventStoreVersionConflictException.name,
					expectedVersion: versions.length,
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

			const fresh = crossVersionEventStream({ aggregate: 'account', aggregateId: crypto.randomUUID() });
			const [created] = await eventStore.appendEvents(fresh, [new NoteAdded('a new stream')], {
				expectedVersion: 0,
				pool: poolOf(pool.pool),
			});
			expect(created.metadata.globalPosition).toBe(BigInt(count + 2));
		});
	});

	describe.each(manifest.snapshotPools)('$collection', (pool) => {
		it('reads every snapshot as 3.0.2 did, with the registeredOn 3.x wrote, and the highest version as the last', async () => {
			for (const stream of pool.streams) {
				const snapshotStream = crossVersionSnapshotStream(stream);
				const envelopes = await collect(snapshotStore.getEnvelopes(snapshotStream, { pool: poolOf(pool.pool) }));
				// Payloads and every metadata field, as 3.0.2 read them
				expect
					.soft(envelopes.map(encodeSnapshotEnvelope), `getEnvelopes(${stream.streamId})`)
					.toEqual(stream.envelopes);

				const written = pool.written.filter(({ streamId }) => streamId === stream.streamId);
				expect
					.soft(
						envelopes.map(({ metadata }) => metadata.version),
						stream.streamId,
					)
					.toEqual(written.map(({ version }) => version).sort((a, b) => a - b));
				for (const { metadata } of envelopes) {
					const row = written.find(({ version }) => version === metadata.version);
					// Converted with the writer's time zone: the instant 3.x meant, to the millisecond
					expect
						.soft(metadata.registeredOn.toISOString(), `${stream.streamId}@${metadata.version}`)
						.toBe(row?.registeredOn);
					expect.soft(metadata.snapshotId).toBe(row?.snapshotId);
				}

				// 3.x read the last snapshot through the flags: a stream with several flags or none now reads its highest
				// version (ADR 0001 D15), every other stream what 3.0.2 read
				const damaged =
					pool.duplicateLatest.some(({ streamId }) => streamId === stream.streamId) ||
					pool.missingLatest.includes(stream.streamId);
				const last = encodeSnapshotEnvelope(await snapshotStore.getLastEnvelope(snapshotStream, poolOf(pool.pool)));
				expect
					.soft(last, `getLastEnvelope(${stream.streamId})`)
					.toEqual(damaged ? stream.envelopes.at(-1) : stream.last);
				expect.soft(last, `getLastEnvelope(${stream.streamId})`).toEqual(encodeSnapshotEnvelope(envelopes.at(-1)));
			}
		});

		it('flags exactly the highest version of every stream, and enforces it with a unique index', async () => {
			const collection = SnapshotCollection.get(poolOf(pool.pool));
			const { rows } = await db.query<{ stream_id: string; flagged: number; highest: boolean }>(
				`SELECT stream_id, count(latest)::int AS flagged,
					bool_and(latest IS NULL OR version = (SELECT max(version) FROM ${escapeIdentifier(collection)} m WHERE m.stream_id = s.stream_id)) AS highest
				FROM ${escapeIdentifier(collection)} s GROUP BY stream_id`,
			);
			expect(rows.length).toBe(pool.streams.length);
			for (const row of rows) {
				expect.soft(row, row.stream_id).toMatchObject({ flagged: 1, highest: true });
			}
			const { rows: indexes } = await db.query(
				`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexdef LIKE 'CREATE UNIQUE INDEX%(aggregate_name, latest) WHERE (latest IS NOT NULL)'`,
				[collection],
			);
			expect(indexes).toHaveLength(1);
		});
	});
});
