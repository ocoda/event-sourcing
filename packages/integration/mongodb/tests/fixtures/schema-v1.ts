import { randomUUID } from 'node:crypto';
import { EventId, type EventStream, type SnapshotStream } from '@ocoda/event-sourcing';
import type { Db, IndexDescription } from 'mongodb';

// The 3.x (schema v1) collections, as @ocoda/event-sourcing-mongodb 3.0.0 to 3.0.2 create and write them: the same
// DDL in every 3.x release (lib/mongodb.event-store.ts and lib/mongodb.snapshot-store.ts at the
// @ocoda/event-sourcing-mongodb@3.0.0 and @3.0.2 tags). No validator; 3.x stores `undefined` metadata as `null`.

/** 3.x `MongoDBEventStore.ensureCollection`: `createCollection(name)`, then these indexes. */
export const V1_EVENT_INDEXES: readonly IndexDescription[] = [
	{ key: { streamId: 1, version: 1 }, unique: true },
	{ key: { eventDate: 1, _id: 1 }, unique: true },
];

/** 3.x `MongoDBSnapshotStore.ensureCollection`: `createCollection(name)`, then these indexes. */
export const V1_SNAPSHOT_INDEXES: readonly IndexDescription[] = [
	{ key: { streamId: 1, version: 1 }, unique: true },
	{ key: { aggregateName: 1, latest: 1 }, unique: false },
];

/** Creates an event collection the way 3.x does. */
export const createV1EventCollection = async (db: Db, name: string): Promise<void> => {
	await db.createCollection(name);
	await db.collection(name).createIndexes([...V1_EVENT_INDEXES]);
};

/** Creates a snapshot collection the way 3.x does. */
export const createV1SnapshotCollection = async (db: Db, name: string): Promise<void> => {
	await db.createCollection(name);
	await db.collection(name).createIndexes([...V1_SNAPSHOT_INDEXES]);
};

/**
 * An event document as 3.x writes it (`_id` is the event id, `eventDate` its UTC year-month).
 */
export const v1EventDocument = (
	stream: EventStream,
	version: number,
	{ eventId = EventId.generate().value, correlationId }: { eventId?: string; correlationId?: string } = {},
) => {
	const date = EventId.fromTrusted(eventId.toUpperCase().replace(/[ILOU]/g, '0')).date;
	return {
		_id: eventId,
		streamId: stream.streamId,
		event: 'account-credited',
		payload: { amount: version },
		eventDate: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
		aggregateId: stream.aggregateId,
		version,
		occurredOn: date,
		correlationId: correlationId ?? null,
		causationId: null,
	};
};

/**
 * A snapshot document as 3.x writes it: flagged `latest#<streamId>` when it's the latest, `latest: null` once 3.x
 * unflagged it.
 */
export const v1SnapshotDocument = (stream: SnapshotStream, version: number, latest: boolean) => {
	const snapshotId = randomUUID();
	return {
		_id: snapshotId,
		streamId: stream.streamId,
		payload: { balance: version },
		aggregateName: stream.aggregate,
		latest: latest ? `latest#${stream.streamId}` : null,
		snapshotId,
		aggregateId: stream.aggregateId,
		registeredOn: new Date(Date.UTC(2022, 0, 1, 0, 0, version)),
		version,
	};
};
