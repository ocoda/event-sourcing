import type { Db } from 'mongodb';

/** The catalog collection of the stores (`CATALOG_COLLECTION` in lib/mongodb.schema.ts). */
export const CATALOG = 'event_sourcing_collections';

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
