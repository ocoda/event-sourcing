import { createHash } from 'node:crypto';
import type { EventEnvelope, EventMap, EventStoreContext, IEvent } from '@ocoda/event-sourcing';
import { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { createTestContext, getEventMap, postgresTestConfig } from '@ocoda/event-sourcing-testing/unit';
import { type Pool, escapeIdentifier, escapeLiteral } from 'pg';
import type { Mock } from 'vitest';

type EventStoreOptions = Omit<ConstructorParameters<typeof PostgresEventStore>[1], 'driver'>;
type SnapshotStoreOptions = Omit<ConstructorParameters<typeof PostgresSnapshotStore>[0], 'driver'>;

export interface TestEventStore {
	store: PostgresEventStore;
	/**
	 * Receives every envelope the store publishes, in order, unless the store was built with a context of its own.
	 */
	publish: Mock<(envelope: EventEnvelope<IEvent>) => Promise<void>>;
	eventMap: EventMap;
}

/**
 * Builds an event store (not connected) on the test database (`postgresTestConfig()`), the way the module does.
 * `eventMapOrContext` is the event map, or a whole store context (the one the conformance suite builds).
 * This is the one place the driver specs construct event stores.
 */
export const createEventStore = (
	overrides: Partial<EventStoreOptions> = {},
	eventMapOrContext: EventMap | EventStoreContext = getEventMap(),
): TestEventStore => {
	const publish = vi.fn(async (_envelope: EventEnvelope<IEvent>) => undefined);
	const context = 'publisher' in eventMapOrContext ? eventMapOrContext : createTestContext(eventMapOrContext, publish);
	const store = new PostgresEventStore(context, { driver: undefined as never, ...postgresTestConfig(), ...overrides });

	return { store, publish, eventMap: context.eventMap };
};

/**
 * Builds a snapshot store (not connected) on the test database (`postgresTestConfig()`), the way the module does.
 * This is the one place the driver specs construct snapshot stores.
 */
export const createSnapshotStore = (overrides: Partial<SnapshotStoreOptions> = {}): PostgresSnapshotStore =>
	new PostgresSnapshotStore({ driver: undefined as never, ...postgresTestConfig(), ...overrides });

/**
 * Drops tables and their catalog rows, if they exist.
 */
export const dropCollections = async (pool: Pool, collections: readonly string[]): Promise<void> => {
	for (const collection of collections) {
		await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(collection)}`);
	}
	const { rows } = await pool.query<{ exists: boolean }>(
		`SELECT to_regclass(format('%I.%I', current_schema(), 'event_sourcing_collections')) IS NOT NULL AS exists`,
	);
	if (rows[0].exists) {
		await pool.query('DELETE FROM event_sourcing_collections WHERE name = ANY ($1)', [collections]);
	}
};

/**
 * Makes every insert of an event with the given name into the table fail, from a `BEFORE INSERT` trigger, so that the
 * rest of the append has to be rolled back. Resolves with a function that removes the trigger.
 */
export const failInsertOf = async (
	pool: Pool,
	collection: string,
	eventName: string,
): Promise<() => Promise<void>> => {
	const suffix = createHash('sha256').update(`${collection}:${eventName}`).digest('hex').slice(0, 12);
	const fn = escapeIdentifier(`es_fault_${suffix}`);
	const trigger = escapeIdentifier(`es_fault_${suffix}`);
	const table = escapeIdentifier(collection);

	await pool.query(
		`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.event = ${escapeLiteral(eventName)} THEN
				RAISE EXCEPTION 'conformance fault: insert of % refused', NEW.event;
			END IF;
			RETURN NEW;
		END $$`,
	);
	await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);

	return async () => {
		await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
		await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
	};
};
