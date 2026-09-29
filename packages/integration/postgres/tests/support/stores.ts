import type { EventEnvelope, EventMap, IEvent } from '@ocoda/event-sourcing';
import { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { getEventMap, postgresTestConfig } from '@ocoda/event-sourcing-testing/unit';
import type { Mock } from 'vitest';

type EventStoreOptions = Omit<ConstructorParameters<typeof PostgresEventStore>[1], 'driver'>;
type SnapshotStoreOptions = Omit<ConstructorParameters<typeof PostgresSnapshotStore>[0], 'driver'>;

export interface TestEventStore {
	store: PostgresEventStore;
	/** The publish function set on the store. */
	publish: Mock<(envelope: EventEnvelope<IEvent>) => Promise<void>>;
	eventMap: EventMap;
}

/**
 * Builds an event store (not connected) on the test database (`postgresTestConfig()`), the way the module does.
 * This is the one place the driver specs construct event stores.
 */
export const createEventStore = (
	overrides: Partial<EventStoreOptions> = {},
	eventMap: EventMap = getEventMap(),
): TestEventStore => {
	const store = new PostgresEventStore(eventMap, { driver: undefined as never, ...postgresTestConfig(), ...overrides });
	const publish = vi.fn(async (_envelope: EventEnvelope<IEvent>) => undefined);
	store.publish = publish;

	return { store, publish, eventMap };
};

/**
 * Builds a snapshot store (not connected) on the test database (`postgresTestConfig()`), the way the module does.
 * This is the one place the driver specs construct snapshot stores.
 */
export const createSnapshotStore = (overrides: Partial<SnapshotStoreOptions> = {}): PostgresSnapshotStore =>
	new PostgresSnapshotStore({ driver: undefined as never, ...postgresTestConfig(), ...overrides });
