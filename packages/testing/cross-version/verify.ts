import type { EventEnvelope, EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import { crossVersionEventStream, crossVersionSnapshotStream } from './domain.js';
import {
	type CrossVersionManifest,
	type EncodedSnapshotEnvelope,
	type EncodedValue,
	encodeEventEnvelope,
	encodeSnapshotEnvelope,
	encodeValue,
	type LegacyOrderEntry,
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

/** `getEnvelopes` and `getEvents` of a stream return what 3.x returned: fields, classes, dates and order. */
export const expectEventStreamReads = async (
	store: EventStore,
	stream: ManifestEventStream,
	pool: string | undefined,
): Promise<void> => {
	const eventStream = crossVersionEventStream(stream);
	const envelopes = await collect(store.getEnvelopes!(eventStream, { pool }));
	expect(envelopes.map(encodeEventEnvelope), `getEnvelopes(${stream.streamId})`).toEqual(stream.envelopes);
	const events = await collect(store.getEvents(eventStream, { pool }));
	expect(events.map(encodeValue), `getEvents(${stream.streamId})`).toEqual(stream.events);
};

/**
 * `getAllEnvelopes` returns the pool in the order 3.x did (`event_date, event_id`). Entries that share an event id
 * (`tie`) may come in any order among themselves.
 */
export const expectLegacyAllOrder = (envelopes: EventEnvelope[], expected: LegacyOrderEntry[]): void => {
	const actual = envelopes.map(({ metadata }) => ({
		eventId: metadata.eventId.value,
		aggregateId: metadata.aggregateId,
		version: metadata.version,
	}));
	const key = ({ eventId, aggregateId, version }: LegacyOrderEntry) => `${eventId} ${aggregateId} ${version}`;

	expect(
		actual.map(({ eventId }) => eventId),
		'event ids in order',
	).toEqual(expected.map(({ eventId }) => eventId));
	expect(actual.map(key).sort(), 'the same rows').toEqual(expected.map(key).sort());
	expect(actual.filter((_, index) => !expected[index].tie).map(key), 'the rows without ties in order').toEqual(
		expected.filter(({ tie }) => !tie).map(key),
	);
};

const versionOf = (envelope: EncodedSnapshotEnvelope | null): EncodedValue | undefined => {
	const metadata = envelope?.metadata;
	return metadata && typeof metadata === 'object' && 'fields' in metadata ? metadata.fields.version : undefined;
};

/**
 * `getEnvelopes` and `getLastEnvelope` of a snapshot stream return what 3.x returned. With two rows flagged latest
 * (`duplicateLatest`), 3.x returns either, so either is accepted.
 */
export const expectSnapshotStreamReads = async (
	store: SnapshotStore,
	stream: ManifestSnapshotStream,
	pool: ManifestSnapshotPool,
): Promise<void> => {
	const snapshotStream = crossVersionSnapshotStream(stream);
	const envelopes = await collect(store.getEnvelopes!(snapshotStream, { pool: poolOf(pool.pool) }));
	expect(envelopes.map(encodeSnapshotEnvelope), `getEnvelopes(${stream.streamId})`).toEqual(stream.envelopes);

	const last = encodeSnapshotEnvelope(await store.getLastEnvelope(snapshotStream, poolOf(pool.pool)));
	const duplicate = pool.duplicateLatest.find(({ streamId }) => streamId === stream.streamId);
	if (duplicate) {
		expect(duplicate.flaggedVersions, `getLastEnvelope(${stream.streamId}) version`).toContain(versionOf(last));
		expect(last, `getLastEnvelope(${stream.streamId})`).toEqual(
			stream.envelopes.find((envelope) => versionOf(envelope) === versionOf(last)),
		);
	} else {
		expect(last, `getLastEnvelope(${stream.streamId})`).toEqual(stream.last);
	}
};

/**
 * `listCollections` lists the corpus collections as 3.x did. 3.x lists matching tables of every schema (PostgreSQL)
 * or database (MariaDB), which other test runs on a shared server may change meanwhile, so outside CI only the corpus
 * collections are compared.
 */
export const expectListedCollections = (actual: string[], expected: string[], corpus: string[]): void => {
	const own = (names: string[]) => [...new Set(names.filter((name) => corpus.includes(name)))].sort();
	expect(own(expected), '3.x listed every corpus collection').toEqual([...corpus].sort());
	expect(own(actual), 'the corpus collections').toEqual([...corpus].sort());
	if (process.env.CI) {
		expect([...actual].sort(), 'every listed collection').toEqual([...expected].sort());
	}
};
