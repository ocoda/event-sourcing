import type { IEventPool } from '../events/event-pool.type.js';

/**
 * What a store's `migrate()` reports while it runs.
 */
export interface MigrationProgress {
	/**
	 * The collection (table) being migrated.
	 */
	collection: string;
	/**
	 * The step being run.
	 */
	step: string;
	/**
	 * The rows done so far, for a step that reports it.
	 */
	done?: number;
	/**
	 * The rows the step handles in total, when known.
	 */
	total?: number;
}

/**
 * The options of a store's `migrate()`, which upgrades the collections of a 3.x store to the 4.0 schema.
 *
 * Stop every 3.x writer before migrating: the migration is offline, and 3.x writes fail loudly afterwards.
 */
export interface MigrationOptions {
	/**
	 * Inspect and plan only: report the steps and their exact statements without writing anything.
	 * @default false
	 */
	dryRun?: boolean;
	/**
	 * The pools to migrate; `undefined` stands for the default pool.
	 * @default every pool whose collections have the shape of a store collection
	 */
	pools?: (IEventPool | undefined)[];
	/**
	 * PostgreSQL snapshots: the IANA time zone the 3.x `TIMESTAMP` columns were written in.
	 * @default the time zone of the process
	 */
	legacyTimeZone?: string;
	/**
	 * MariaDB events: restore `occurred_on` from the event id when the two differ by a time-zone offset or only in
	 * precision.
	 * @default true
	 */
	repairOccurredOn?: boolean;
	/**
	 * MariaDB: keep the copy of every migrated table.
	 * @default true
	 */
	keepBackup?: boolean;
	/**
	 * How long to wait for a lock on a collection before reporting it as blocked, in milliseconds.
	 * @default 10_000
	 */
	lockTimeoutMs?: number;
	/**
	 * MongoDB: take over the lease of a migration that expired or went stale.
	 * @default false
	 */
	force?: boolean;
	/**
	 * Called as the migration progresses.
	 */
	onProgress?: (progress: MigrationProgress) => void;
}
