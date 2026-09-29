import type { EventEnvelope, EventMap, IEvent } from '@ocoda/event-sourcing';
import { MongoDBEventStore, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { getEventMap, mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import type { Mock } from 'vitest';

type EventStoreOptions = Omit<ConstructorParameters<typeof MongoDBEventStore>[1], 'driver'>;
type SnapshotStoreOptions = Omit<ConstructorParameters<typeof MongoDBSnapshotStore>[0], 'driver'>;

/** The standalone server, which `mongodbTestTopologies()` always lists first. */
const standaloneUrl = () => mongodbTestTopologies()[0].url;

export interface TestEventStore {
	store: MongoDBEventStore;
	/** The publish function set on the store. */
	publish: Mock<(envelope: EventEnvelope<IEvent>) => Promise<void>>;
	eventMap: EventMap;
}

/**
 * Builds an event store (not connected) the way the module does, on the standalone test server unless `overrides`
 * has the `url` of another topology (`mongodbTestTopologies()`).
 * This is the one place the driver specs construct event stores.
 */
export const createEventStore = (
	overrides: Partial<EventStoreOptions> = {},
	eventMap: EventMap = getEventMap(),
): TestEventStore => {
	const store = new MongoDBEventStore(eventMap, { driver: undefined as never, url: standaloneUrl(), ...overrides });
	const publish = vi.fn(async (_envelope: EventEnvelope<IEvent>) => undefined);
	store.publish = publish;

	return { store, publish, eventMap };
};

/**
 * Builds a snapshot store (not connected) the way the module does, on the standalone test server unless `overrides`
 * has the `url` of another topology (`mongodbTestTopologies()`).
 * This is the one place the driver specs construct snapshot stores.
 */
export const createSnapshotStore = (overrides: Partial<SnapshotStoreOptions> = {}): MongoDBSnapshotStore =>
	new MongoDBSnapshotStore({ driver: undefined as never, url: standaloneUrl(), ...overrides });
