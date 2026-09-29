import { readFileSync } from 'node:fs';
import type { EventEnvelope, SnapshotEnvelope } from '@ocoda/event-sourcing';

/**
 * The manifest that fixtures/cross-version/v3/writer.mjs writes: what 3.0.2 wrote into a namespace and what 3.0.2
 * read back from it. See scripts/test-cross-version.mjs.
 */
export interface CrossVersionManifest {
	format: 1;
	database: 'postgres' | 'mariadb' | 'mongodb';
	/** The PostgreSQL schema, MariaDB database or MongoDB database the corpus is in. */
	namespace: string;
	/** The writer's process time zone; 3.x reads of MariaDB and PostgreSQL snapshot `TIMESTAMP`s depend on it. */
	writerTimeZone: string;
	writer: { node: string; packages: Record<string, string>; server: string };
	/** The `since` of the `getAllEnvelopes` calls behind `legacyAllOrder`. */
	allEnvelopesSince: { year: number; month: number };
	/** 3.x `listCollections()` of the event store and the snapshot store, as returned. */
	eventCollections: string[];
	snapshotCollections: string[];
	eventPools: ManifestEventPool[];
	snapshotPools: ManifestSnapshotPool[];
	/**
	 * The schema after the writes: PostgreSQL `{ indexes: { [table]: { name, definition }[] } }`, MariaDB
	 * `{ tables: { [table]: SHOW CREATE TABLE } }`, MongoDB `{ indexes: { [collection]: { name, key, unique }[] } }`.
	 */
	schema: unknown;
	/** MariaDB: `SHOW CREATE TABLE` of the tables created with the legacy `ON UPDATE` DDL. */
	legacyDdl?: Record<string, string>;
}

export interface ManifestEventPool {
	/** The pool name, `null` for the default pool. */
	pool: string | null;
	collection: string;
	/** Every event the writer appended, as `appendEvents` returned it (`occurredOn` with milliseconds). */
	written: WrittenEvent[];
	streams: ManifestEventStream[];
	/** 3.x `getAllEnvelopes` over every month since `allEnvelopesSince`: `ORDER BY event_date, event_id`. */
	legacyAllOrder: LegacyOrderEntry[];
	gappedStreams: string[];
	/** MariaDB: stream ids that differ in case only (the 3.x tables compare them case-insensitively). */
	caseVariantStreams: string[];
	/** SQL: event ids that more than one row has. */
	duplicateEventIds: string[];
}

export interface WrittenEvent {
	streamId: string;
	aggregateId: string;
	version: number;
	eventId: string;
	occurredOn: string;
}

export interface ManifestEventStream {
	/** The stream name of the aggregate (see `crossVersionEventStream`). */
	aggregate: string;
	aggregateId: string;
	streamId: string;
	/** 3.x `getEnvelopes(stream, { pool })`. */
	envelopes: EncodedEventEnvelope[];
	/** 3.x `getEvents(stream, { pool })`: the deserialized events. */
	events: EncodedValue[];
}

export interface LegacyOrderEntry {
	eventId: string;
	aggregateId: string;
	version: number;
	/** Set when other entries share the event id: the order among them is undefined. */
	tie?: true;
}

export interface ManifestSnapshotPool {
	pool: string | null;
	collection: string;
	/** Every snapshot the writer appended, as `appendSnapshot` returned it. */
	written: WrittenSnapshot[];
	streams: ManifestSnapshotStream[];
	/** Streams with two rows flagged latest: 3.x `getLastEnvelope` returns either. */
	duplicateLatest: { streamId: string; flaggedVersions: number[] }[];
	/** Streams without a row flagged latest: 3.x `getLastEnvelope` returns nothing. */
	missingLatest: string[];
}

export interface WrittenSnapshot {
	streamId: string;
	aggregateId: string;
	version: number;
	snapshotId: string;
	registeredOn: string;
}

export interface ManifestSnapshotStream {
	aggregate: string;
	aggregateId: string;
	streamId: string;
	/** 3.x `getEnvelopes(stream, { pool })`. */
	envelopes: EncodedSnapshotEnvelope[];
	/** 3.x `getLastEnvelope(stream, pool)`, `null` when it returned nothing. */
	last: EncodedSnapshotEnvelope | null;
}

/**
 * A JSON form of a value that keeps what JSON loses: classes (`$class` is the constructor name, `Object` for plain
 * objects), Dates vs strings, `undefined`.
 */
export type EncodedValue =
	| null
	| string
	| number
	| boolean
	| EncodedValue[]
	| { $undefined: true }
	| { $number: string }
	| { $bigint: string }
	| { $date: string | null }
	| { $class: string | null; fields: Record<string, EncodedValue> }
	| { $unsupported: string };

export interface EncodedEventEnvelope {
	event: string;
	payload: EncodedValue;
	/** The metadata with `eventId` as its string value. */
	metadata: EncodedValue;
}

export interface EncodedSnapshotEnvelope {
	payload: EncodedValue;
	metadata: EncodedValue;
}

/** The same function as `encodeValue` in fixtures/cross-version/v3/writer.mjs. Change both together. */
export const encodeValue = (value: unknown): EncodedValue => {
	if (value === undefined) return { $undefined: true };
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		return Number.isFinite(value) && !Object.is(value, -0) ? value : { $number: String(value) };
	}
	if (typeof value === 'bigint') return { $bigint: value.toString() };
	if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
	if (Array.isArray(value)) return value.map(encodeValue);
	if (typeof value === 'object') {
		const prototype = Object.getPrototypeOf(value);
		return {
			$class:
				prototype === null ? null : prototype === Object.prototype ? 'Object' : (prototype.constructor?.name ?? '?'),
			fields: Object.fromEntries(
				Object.keys(value).map((key) => [key, encodeValue((value as Record<string, unknown>)[key])]),
			),
		};
	}
	return { $unsupported: typeof value };
};

export const encodeEventEnvelope = ({ event, payload, metadata }: EventEnvelope): EncodedEventEnvelope => ({
	event,
	payload: encodeValue(payload),
	metadata: encodeValue({ ...metadata, eventId: metadata.eventId.value }),
});

export const encodeSnapshotEnvelope = (
	envelope: SnapshotEnvelope | void | undefined,
): EncodedSnapshotEnvelope | null =>
	envelope ? { payload: encodeValue(envelope.payload), metadata: encodeValue(envelope.metadata) } : null;

/**
 * Reads the manifest named by `XV_MANIFEST`, which scripts/test-cross-version.mjs sets after running the writer.
 */
export const loadCrossVersionManifest = (path = process.env.XV_MANIFEST): CrossVersionManifest => {
	if (!path) {
		throw new Error(
			'XV_MANIFEST is not set: the cross-version specs read the corpus that 3.0.2 wrote first. Run them with ' +
				'`pnpm test:cross-version --database <postgres|mariadb|mongodb>` (scripts/test-cross-version.mjs).',
		);
	}
	const manifest = JSON.parse(readFileSync(path, 'utf8')) as CrossVersionManifest;
	if (manifest.format !== 1) {
		throw new Error(`${path} has manifest format ${manifest.format}, these specs read format 1`);
	}
	return manifest;
};
