import type { EventEnvelope, EventMap, EventStoreContext, IEvent } from '@ocoda/event-sourcing';
import { MongoDBEventStore, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { createTestContext, getEventMap, mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import type { Mock } from 'vitest';

type EventStoreOptions = Omit<ConstructorParameters<typeof MongoDBEventStore>[1], 'driver'>;
type SnapshotStoreOptions = Omit<ConstructorParameters<typeof MongoDBSnapshotStore>[0], 'driver'>;

/** The standalone server, which `mongodbTestTopologies()` always lists first. */
const standaloneUrl = () => mongodbTestTopologies()[0].url;

export interface TestEventStore {
	store: MongoDBEventStore;
	/**
	 * Receives every envelope the store publishes, in order, unless the store was built with a context of its own.
	 */
	publish: Mock<(envelope: EventEnvelope<IEvent>) => Promise<void>>;
	eventMap: EventMap;
}

/**
 * Builds an event store (not connected) the way the module does, on the standalone test server unless `overrides`
 * has the `url` of another topology (`mongodbTestTopologies()`).
 * `eventMapOrContext` is the event map, or a whole store context (the one the conformance suite builds).
 * This is the one place the driver specs construct event stores.
 */
export const createEventStore = (
	overrides: Partial<EventStoreOptions> = {},
	eventMapOrContext: EventMap | EventStoreContext = getEventMap(),
): TestEventStore => {
	const publish = vi.fn(async (_envelope: EventEnvelope<IEvent>) => undefined);
	const context = 'publisher' in eventMapOrContext ? eventMapOrContext : createTestContext(eventMapOrContext, publish);
	const store = new MongoDBEventStore(context, { driver: undefined as never, url: standaloneUrl(), ...overrides });

	return { store, publish, eventMap: context.eventMap };
};

/**
 * Builds a snapshot store (not connected) the way the module does, on the standalone test server unless `overrides`
 * has the `url` of another topology (`mongodbTestTopologies()`).
 * This is the one place the driver specs construct snapshot stores.
 */
export const createSnapshotStore = (overrides: Partial<SnapshotStoreOptions> = {}): MongoDBSnapshotStore =>
	new MongoDBSnapshotStore({ driver: undefined as never, url: standaloneUrl(), ...overrides });
