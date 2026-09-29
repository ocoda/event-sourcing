import { Long } from 'mongodb';
import type { Db, Document, IndexDescription } from 'mongodb';

/**
 * The catalog of a database: one document per collection of the stores (`{ _id: <collection>, kind, schemaVersion }`,
 * and for event collections the pool's position counter `lastPosition`), plus the leases of running migrations
 * (`kind: 'lock'`). The name neither ends in nor contains `events`, so 3.x listing code never picks it up.
 */
export const CATALOG_COLLECTION = 'event_sourcing_collections';

/** The schema version of the 4.0 event and snapshot collections. */
export const SCHEMA_VERSION = 2;

/**
 * The validator of a 4.0 event collection: every event has a 64-bit `globalPosition`. It rejects 3.x-shaped inserts
 * (code 121), which fences 3.x writers off a migrated collection.
 */
export const EVENTS_VALIDATOR: Document = Object.freeze({
	$jsonSchema: {
		bsonType: 'object',
		required: ['globalPosition', 'streamId', 'version'],
		properties: { globalPosition: { bsonType: 'long' } },
	},
});

/** The validation options that go with `EVENTS_VALIDATOR`. */
export const VALIDATION_OPTIONS = Object.freeze({ validationLevel: 'strict', validationAction: 'error' } as const);

/** The indexes of a 4.0 event collection. */
export const EVENT_INDEXES: readonly IndexDescription[] = [
	{ key: { streamId: 1, version: 1 }, unique: true },
	{ key: { globalPosition: 1 }, unique: true },
];

/** The name of the index that allows one latest snapshot per stream. */
export const LATEST_UNIQUE_INDEX = 'latest_unique';

/** The indexes of a 4.0 snapshot collection. An unflagged snapshot has no `latest` field. */
export const SNAPSHOT_INDEXES: readonly IndexDescription[] = [
	{ key: { streamId: 1, version: 1 }, unique: true },
	{
		key: { aggregateName: 1, latest: 1 },
		unique: true,
		partialFilterExpression: { latest: { $type: 'string' } },
		name: LATEST_UNIQUE_INDEX,
	},
];

/** A document of the catalog. */
export type CatalogDocument =
	| { _id: string; kind: 'events'; schemaVersion: number; lastPosition: Long | number | bigint }
	| { _id: string; kind: 'snapshots'; schemaVersion: number }
	| { _id: string; kind: 'lock'; owner: string; expiresAt: Date };

/** An index as `listIndexes` describes it. */
export interface IndexInfo {
	name: string;
	key: Record<string, unknown>;
	unique?: boolean;
	partialFilterExpression?: Document;
}

/** What `listCollections` and `listIndexes` tell about a collection. */
export interface CollectionShape {
	exists: boolean;
	/** The collection's validator, if it has one. */
	validator?: Document;
	indexes: IndexInfo[];
}

const sameKey = (key: Record<string, unknown>, expected: Record<string, unknown>): boolean => {
	const fields = Object.keys(key);
	const expectedFields = Object.keys(expected);
	return (
		fields.length === expectedFields.length &&
		fields.every((field, index) => field === expectedFields[index] && Number(key[field]) === expected[field])
	);
};

/** The index with exactly this key (fields in this order, ascending or descending as given), if any. */
export const findIndex = (indexes: readonly IndexInfo[], key: Record<string, number>): IndexInfo | undefined =>
	indexes.find((index) => sameKey(index.key, key));

/** Whether the collection has the unique index of the given key. */
export const hasUniqueIndex = (indexes: readonly IndexInfo[], key: Record<string, number>): boolean =>
	indexes.some((index) => index.unique === true && sameKey(index.key, key));

/** Whether the snapshot collection has the unique, partial index on the latest flag (schema v2). */
export const hasLatestUniqueIndex = (indexes: readonly IndexInfo[]): boolean =>
	indexes.some(
		(index) =>
			index.unique === true &&
			index.partialFilterExpression !== undefined &&
			sameKey(index.key, { aggregateName: 1, latest: 1 }),
	);

/**
 * Reads whether a collection exists, with its validator and indexes, in one `listCollections` call plus a
 * `listIndexes` call when it exists.
 */
export const readCollectionShape = async (db: Db, name: string): Promise<CollectionShape> => {
	const [info] = await db.listCollections({ name }, { nameOnly: false }).toArray();
	if (!info) {
		return { exists: false, indexes: [] };
	}
	const indexes = (await db.collection(name).listIndexes().toArray()) as IndexInfo[];
	const validator = (info as { options?: { validator?: Document } }).options?.validator;
	return { exists: true, validator: validator && Object.keys(validator).length > 0 ? validator : undefined, indexes };
};

/** Whether a collection has no validator, the 4.0 event validator, or another one. */
export const classifyValidator = (validator: Document | undefined): 'none' | 'v2' | 'other' => {
	if (validator === undefined) {
		return 'none';
	}
	return JSON.stringify(validator) === JSON.stringify(EVENTS_VALIDATOR) ? 'v2' : 'other';
};

/** Whether the database has the catalog collection. */
export const catalogExists = async (db: Db): Promise<boolean> =>
	(await db.listCollections({ name: CATALOG_COLLECTION }, { nameOnly: true }).toArray()).length > 0;

/**
 * Renders a value as a mongosh literal, for the statements of a dry run and the remedies of schema errors: strings in
 * single quotes, `NumberLong('…')` for 64-bit integers, `ISODate('…')` for dates.
 */
export const toShell = (value: unknown): string => {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'bigint') return `NumberLong('${value}')`;
	if (value instanceof Long) return `NumberLong('${value.toString()}')`;
	if (value instanceof Date) return `ISODate('${value.toISOString()}')`;
	if (value instanceof RegExp) return String(value);
	if (Array.isArray(value)) return `[${value.map(toShell).join(', ')}]`;
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).map(
			([key, entry]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : toShell(key)}: ${toShell(entry)}`,
		);
		return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
	}
	return String(value);
};

/** `db.getCollection('<name>')`: works for every collection name, also those with a hyphen. */
export const shellCollection = (name: string): string => `db.getCollection(${toShell(name)})`;

/** The mongosh statement that registers a collection in the catalog. */
export const registrationStatement = (
	name: string,
	kind: 'events' | 'snapshots',
	schemaVersion: number,
	lastPosition?: bigint,
): string =>
	`${shellCollection(CATALOG_COLLECTION)}.updateOne(${toShell({ _id: name })}, ${toShell({
		$setOnInsert: { kind },
		$set: { schemaVersion },
		...(lastPosition === undefined ? {} : { $max: { lastPosition } }),
	})}, { upsert: true })`;

const createStatements = (name: string, options: Document, indexes: readonly IndexDescription[]): string[] => [
	`db.createCollection(${toShell(name)}${Object.keys(options).length > 0 ? `, ${toShell(options)}` : ''})`,
	`${shellCollection(name)}.createIndexes(${toShell(indexes)})`,
];

/**
 * The mongosh statements that create a 4.0 event collection and register it, for databases whose store runs with
 * `ddl: 'none'`.
 */
export const eventCollectionDdl = (name: string): string[] => [
	...createStatements(name, { validator: EVENTS_VALIDATOR, ...VALIDATION_OPTIONS }, EVENT_INDEXES),
	registrationStatement(name, 'events', SCHEMA_VERSION, 0n),
];

/**
 * The mongosh statements that restore the validator and the unique indexes of a registered 4.0 event collection.
 */
export const eventCollectionRepairDdl = (name: string): string[] => [
	`db.runCommand(${toShell({ collMod: name, validator: EVENTS_VALIDATOR, ...VALIDATION_OPTIONS })})`,
	`${shellCollection(name)}.createIndexes(${toShell(EVENT_INDEXES)})`,
];

/**
 * The mongosh statements that create a 4.0 snapshot collection and register it, for databases whose store runs with
 * `ddl: 'none'`.
 */
export const snapshotCollectionDdl = (name: string): string[] => [
	...createStatements(name, {}, SNAPSHOT_INDEXES),
	registrationStatement(name, 'snapshots', SCHEMA_VERSION),
];

/** The mongosh statement that creates the catalog. */
export const catalogDdl = (): string => `db.createCollection(${toShell(CATALOG_COLLECTION)})`;
