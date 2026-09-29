import type { MigrationOptions } from '@ocoda/event-sourcing';

/**
 * The options of `MongoDBEventStore.migrate()` and `MongoDBSnapshotStore.migrate()`.
 */
export interface MongoDBMigrationOptions extends MigrationOptions {
	/**
	 * Events: remove the 3.x `eventDate` field from every event, in batches, once the collection is migrated (after the
	 * commit point). 4.0 ignores the field, so `false` defers it, for instance to spread the oplog volume over time; a
	 * later `migrate()` removes it.
	 * @default true
	 */
	unsetEventDate?: boolean;
}
