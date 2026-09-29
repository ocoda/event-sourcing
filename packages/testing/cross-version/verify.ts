import type { EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import { crossVersionEventStream, crossVersionSnapshotStream } from './domain.js';
import {
	type CrossVersionManifest,
	type EncodedSnapshotEnvelope,
	type EncodedValue,
	encodeEventEnvelope,
	encodeSnapshotEnvelope,
	encodeValue,
	type ManifestEventStream,
	type ManifestSnapshotPool,
	type ManifestSnapshotStream,
} from './manifest.js';

// Assertions for the cross-version specs of the drivers (packages/integration/<db>/tests/cross-version). Each spec
// composes them, so a driver can replace one for its schema v2 without touching the others.

export const collect = async <T>(batches: AsyncIterable<T[]>): Promise<T[]> => {
	const items: T[] = [];
	for await (const batch of batches) items.push(...batch);
	return items;
};

/** Whether the specs run in CI (`CI` set and not `false`, like scripts/test-cross-version.mjs and unit/db.ts). */
export const crossVersionRunsInCI = Boolean(process.env.CI) && process.env.CI !== 'false';

/** The pool argument of the store methods for a manifest pool (`null` is the default pool). */
export const poolOf = (pool: string | null): string | undefined => pool ?? undefined;

/**
 * 3.x reads of MariaDB `TIMESTAMP` columns and PostgreSQL snapshot `TIMESTAMP` columns depend on the process time
 * zone, so reading "as 3.0.2 did" means reading in the writer's time zone. scripts/test-cross-version.mjs sets `TZ`.
 */
export const expectWriterTimeZone = (manifest: CrossVersionManifest): void => {
	expect(
		Intl.DateTimeFormat().resolvedOptions().timeZone,
		`run the cross-version specs with TZ=${manifest.writerTimeZone}, the time zone of the 3.0.2 writer`,
	).toBe(manifest.writerTimeZone);
};

/**
 * The manifest holds the whole corpus: 3.x read back every event and snapshot the writer appended, so an empty or
 * hollow manifest can't pass the read checks. writer.mjs checks the same before it writes the manifest.
 */
export const expectCompleteCorpus = (manifest: CrossVersionManifest): void => {
	expect(manifest.eventPools.length, 'event pools').toBeGreaterThanOrEqual(3);
	expect(manifest.snapshotPools.length, 'snapshot pools').toBeGreaterThanOrEqual(3);
	for (const pool of manifest.eventPools) {
		expect(pool.streams.length, `${pool.collection}: streams`).toBeGreaterThan(0);
		expect(
			pool.legacyAllOrder,
			`${pool.collection}: the 3.x read of all events covered every written event`,
		).toHaveLength(pool.written.length);
		for (const stream of pool.streams) {
			if (pool.caseVariantStreams.includes(stream.streamId)) continue;
			const written = pool.written.filter(({ streamId }) => streamId === stream.streamId).length;
			expect(written, `${stream.streamId}: written events`).toBeGreaterThan(0);
			expect(stream.envelopes, `${stream.streamId}: 3.x read back every written event`).toHaveLength(written);
		}
	}
	for (const pool of manifest.snapshotPools) {
		expect(pool.streams.length, `${pool.collection}: snapshot streams`).toBeGreaterThan(0);
		expect(
			pool.streams.flatMap(({ envelopes }) => envelopes),
			`${pool.collection}: 3.x read back every snapshot`,
		).toHaveLength(pool.written.length);
	}
};

/**
 * `getEnvelopes` and `getEvents` of a stream return what 3.x returned: fields, classes, dates and order. Soft
 * assertions, so one run reports every stream that differs.
 */
export const expectEventStreamReads = async (
	store: EventStore,
	stream: ManifestEventStream,
	pool: string | undefined,
): Promise<void> => {
	const eventStream = crossVersionEventStream(stream);
	const envelopes = await collect(store.getEnvelopes!(eventStream, { pool }));
	expect.soft(envelopes.map(encodeEventEnvelope), `getEnvelopes(${stream.streamId})`).toEqual(stream.envelopes);
	const events = await collect(store.getEvents(eventStream, { pool }));
	expect.soft(events.map(encodeValue), `getEvents(${stream.streamId})`).toEqual(stream.events);
};

const versionOf = (envelope: EncodedSnapshotEnvelope | null): EncodedValue | undefined => {
	const metadata = envelope?.metadata;
	return metadata && typeof metadata === 'object' && 'fields' in metadata ? metadata.fields.version : undefined;
};

/**
 * `getEnvelopes` and `getLastEnvelope` of a snapshot stream return what 3.x returned. With two rows flagged latest
 * (`duplicateLatest`), 3.x returns either, so either is accepted. Soft assertions, like expectEventStreamReads.
 */
export const expectSnapshotStreamReads = async (
	store: SnapshotStore,
	stream: ManifestSnapshotStream,
	pool: ManifestSnapshotPool,
): Promise<void> => {
	const snapshotStream = crossVersionSnapshotStream(stream);
	const envelopes = await collect(store.getEnvelopes!(snapshotStream, { pool: poolOf(pool.pool) }));
	expect.soft(envelopes.map(encodeSnapshotEnvelope), `getEnvelopes(${stream.streamId})`).toEqual(stream.envelopes);

	const last = encodeSnapshotEnvelope(await store.getLastEnvelope(snapshotStream, poolOf(pool.pool)));
	const duplicate = pool.duplicateLatest.find(({ streamId }) => streamId === stream.streamId);
	if (duplicate) {
		expect.soft(duplicate.flaggedVersions, `getLastEnvelope(${stream.streamId}) version`).toContain(versionOf(last));
		expect
			.soft(last, `getLastEnvelope(${stream.streamId})`)
			.toEqual(stream.envelopes.find((envelope) => versionOf(envelope) === versionOf(last)));
	} else {
		expect.soft(last, `getLastEnvelope(${stream.streamId})`).toEqual(stream.last);
	}
};

/**
 * `listCollections` lists the corpus collections as 3.x did. 3.x lists matching tables of every schema (PostgreSQL)
 * or database (MariaDB), which other test runs on a shared server may change meanwhile: expectEveryListedCollection
 * compares the whole lists where the server is the run's own.
 */
export const expectListedCollections = (actual: string[], expected: string[], corpus: string[]): void => {
	const own = (names: string[]) => [...new Set(names.filter((name) => corpus.includes(name)))].sort();
	expect(own(expected), '3.x listed every corpus collection').toEqual([...corpus].sort());
	expect(own(actual), 'the corpus collections').toEqual([...corpus].sort());
};

/**
 * `listCollections` lists every collection 3.x listed, and no other. PostgreSQL and MariaDB: CI only (a server no
 * other run writes to).
 */
export const expectEveryListedCollection = (actual: string[], expected: string[]): void => {
	expect([...actual].sort(), 'every listed collection').toEqual([...expected].sort());
};
