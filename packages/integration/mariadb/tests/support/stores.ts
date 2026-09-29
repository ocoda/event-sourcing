import { randomBytes } from 'node:crypto';
import type { EventEnvelope, EventMap, EventStoreContext, IEvent } from '@ocoda/event-sourcing';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import {
	type SqlTestConfig,
	createTestContext,
	getEventMap,
	mariadbRootConfig,
	mariadbTestConfig,
} from '@ocoda/event-sourcing-testing/unit';
import { type Connection, type Pool, createConnection } from 'mariadb';
import type { Mock } from 'vitest';

type EventStoreOptions = Omit<ConstructorParameters<typeof MariaDBEventStore>[1], 'driver'>;
type SnapshotStoreOptions = Omit<ConstructorParameters<typeof MariaDBSnapshotStore>[0], 'driver'>;

/** The catalog of the stores (see lib/mariadb.schema.ts). */
export const CATALOG = 'event_sourcing_collections';

export interface TestEventStore {
	store: MariaDBEventStore;
	/**
	 * Receives every envelope the store publishes, in order, unless the store was built with a context of its own.
	 */
	publish: Mock<(envelope: EventEnvelope<IEvent>) => Promise<void>>;
	eventMap: EventMap;
}

/**
 * Builds an event store (not connected) on the test database (`mariadbTestConfig()`), the way the module does.
 * `eventMapOrContext` is the event map, or a whole store context (the one the conformance suite builds).
 * This is the one place the driver specs construct event stores.
 */
export const createEventStore = (
	overrides: Partial<EventStoreOptions> = {},
	eventMapOrContext: EventMap | EventStoreContext = getEventMap(),
): TestEventStore => {
	const publish = vi.fn(async (_envelope: EventEnvelope<IEvent>) => undefined);
	const context = 'publisher' in eventMapOrContext ? eventMapOrContext : createTestContext(eventMapOrContext, publish);
	const store = new MariaDBEventStore(context, { driver: undefined as never, ...mariadbTestConfig(), ...overrides });

	return { store, publish, eventMap: context.eventMap };
};

/**
 * Builds a snapshot store (not connected) on the test database (`mariadbTestConfig()`), the way the module does.
 * This is the one place the driver specs construct snapshot stores.
 */
export const createSnapshotStore = (overrides: Partial<SnapshotStoreOptions> = {}): MariaDBSnapshotStore =>
	new MariaDBSnapshotStore({ driver: undefined as never, ...mariadbTestConfig(), ...overrides });

/** The connection pool of a connected store. */
export const poolOf = (store: MariaDBEventStore | MariaDBSnapshotStore): Pool => store['pool'] as unknown as Pool;

const escapeId = (name: string) => `\`${name.replaceAll('`', '``')}\``;

/** Drops tables, and their catalog rows. Tables that don't exist are ignored. */
export const dropTables = async (db: Pool | Connection, tables: readonly string[]): Promise<void> => {
	for (const table of tables) {
		await db.query(`DROP TABLE IF EXISTS ${escapeId(table)}`);
	}
	if (tables.length > 0) {
		await db.query(`DELETE FROM ${CATALOG} WHERE name IN (?)`, [tables]).catch((error: { errno?: number }) => {
			if (error?.errno !== 1146) {
				throw error;
			}
		});
	}
};

export const dropEventCollections = (store: MariaDBEventStore, collections: readonly string[]) =>
	dropTables(poolOf(store), collections);

/**
 * Makes every insert of an event with the given name into the collection fail from inside the database: a
 * `BEFORE INSERT` trigger that signals an error. Resolves with a function that drops the trigger.
 */
export const failInsertsOf = async (
	store: MariaDBEventStore,
	collection: string,
	eventName: string,
): Promise<() => Promise<void>> => {
	const pool = poolOf(store);
	const trigger = `es_fault_${randomBytes(6).toString('hex')}`;
	await pool.query(
		`CREATE TRIGGER ${escapeId(trigger)} BEFORE INSERT ON ${escapeId(collection)} FOR EACH ROW
		 BEGIN
			IF NEW.event = ${pool.escape(eventName)} THEN
				SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'conformance: injected insert failure';
			END IF;
		 END`,
	);
	return async () => {
		await pool.query(`DROP TRIGGER IF EXISTS ${escapeId(trigger)}`);
	};
};

/** A connection as root to the test database, for setup the test user can't do. */
export const rootConnection = (database?: string): Promise<Connection> =>
	createConnection({ ...mariadbRootConfig(), ...(database ? { database } : {}) });

/**
 * A database of its own for a spec (created as root, granted to the test user), for specs that need a catalog or a
 * set of tables no other spec touches. `drop` removes exactly this database.
 */
export const createTestDatabase = async (
	label: string,
): Promise<{ name: string; config: SqlTestConfig; drop: () => Promise<void> }> => {
	const config = mariadbTestConfig();
	const name = `${config.database}_${label}_${randomBytes(3).toString('hex')}`.slice(0, 64);
	const root = await rootConnection();
	try {
		await root.query(`CREATE DATABASE ${escapeId(name)}`);
		await root.query(`GRANT ALL ON ${escapeId(name)}.* TO ?@'%'`, [config.user]);
	} finally {
		await root.end();
	}
	return {
		name,
		config: { ...config, database: name },
		drop: async () => {
			const connection = await rootConnection();
			try {
				await connection.query(`DROP DATABASE IF EXISTS ${escapeId(name)}`);
			} finally {
				await connection.end();
			}
		},
	};
};
