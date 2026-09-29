import type { EventEnvelope, EventMap, EventStoreContext, IEvent } from '@ocoda/event-sourcing';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { createTestContext, getEventMap, mariadbTestConfig } from '@ocoda/event-sourcing-testing/unit';
import type { Mock } from 'vitest';

type EventStoreOptions = Omit<ConstructorParameters<typeof MariaDBEventStore>[1], 'driver'>;
type SnapshotStoreOptions = Omit<ConstructorParameters<typeof MariaDBSnapshotStore>[0], 'driver'>;

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
	const context =
		'publisher' in eventMapOrContext ? eventMapOrContext : createTestContext(eventMapOrContext, publish);
	const store = new MariaDBEventStore(context, { driver: undefined as never, ...mariadbTestConfig(), ...overrides });

	return { store, publish, eventMap: context.eventMap };
};

/**
 * Builds a snapshot store (not connected) on the test database (`mariadbTestConfig()`), the way the module does.
 * This is the one place the driver specs construct snapshot stores.
 */
export const createSnapshotStore = (overrides: Partial<SnapshotStoreOptions> = {}): MariaDBSnapshotStore =>
	new MariaDBSnapshotStore({ driver: undefined as never, ...mariadbTestConfig(), ...overrides });
