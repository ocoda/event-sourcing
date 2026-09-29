import type { EventEnvelope, EventMap, EventStoreContext, IEvent } from '@ocoda/event-sourcing';
import { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { createTestContext, getEventMap, postgresTestConfig } from '@ocoda/event-sourcing-testing/unit';
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
