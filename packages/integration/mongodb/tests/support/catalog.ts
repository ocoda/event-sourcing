import type { Collection, Db, Document } from 'mongodb';

/** The catalog collection of the stores (`CATALOG_COLLECTION` in lib/mongodb.schema.ts). */
export const CATALOG = 'event_sourcing_collections';

/** A document as the specs read and write it directly: string ids, like every document the stores write. */
export type RawDocument = Document & { _id?: string };

/** A collection for direct access in the specs, with string ids. */
export const rawCollection = (database: Db, name: string): Collection<RawDocument> =>
	database.collection<RawDocument>(name);

/**
 * Drops collections and their catalog documents (registration and migration lease), ignoring those that don't exist.
 * Never drops the catalog itself: other specs of the same database use it.
 */
export const dropCollections = async (database: Db, collections: readonly string[]): Promise<void> => {
	for (const collection of collections) {
		await database.dropCollection(collection).catch(() => undefined);
	}
	await database
		.collection<{ _id: string }>(CATALOG)
		.deleteMany({ _id: { $in: [...collections, ...collections.map((collection) => `lock:migrate:${collection}`)] } });
};
