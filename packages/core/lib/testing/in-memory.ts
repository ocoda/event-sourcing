import type { Type } from '@nestjs/common';
import { EventMap } from '../event-map.js';
import { InMemoryEventStore, InMemorySnapshotStore } from '../integration/index.js';
import type { EventStoreContext, IEvent } from '../interfaces/index.js';
import { RecordingPublisher } from './recording-publisher.js';

/**
 * The events of a test store context.
 */
export interface TestEventStoreContextOptions {
	/**
	 * The events the store reads and writes, registered with the default serializer.
	 */
	events?: Type<IEvent>[];
	/**
	 * The event map to register the events in, for events with a serializer of their own. Defaults to a new one.
	 */
	eventMap?: EventMap;
}

/**
 * A store context whose publisher records what the store publishes.
 */
export interface TestEventStoreContext extends EventStoreContext {
	readonly publisher: RecordingPublisher;
}

/**
 * An in-memory event store for a test, with what it was constructed with.
 */
export interface InMemoryTestEventStore extends TestEventStoreContext {
	/**
	 * The connected store. Its default pool exists.
	 */
	readonly store: InMemoryEventStore;
}

/**
 * Creates the context the module would hand an event store: an event map with the given events, and a
 * `RecordingPublisher` in place of the event bus, so a test can check what an append published.
 *
 * @example
 * const context = createTestEventStoreContext({ events: [AccountOpened] });
 * const store = new FooEventStore(context, { ... });
 */
export const createTestEventStoreContext = ({
	events = [],
	eventMap = new EventMap(),
}: TestEventStoreContextOptions = {}): TestEventStoreContext => {
	eventMap.registerSerializers(events);
	return { eventMap, publisher: new RecordingPublisher() };
};

/**
 * Creates a connected `InMemoryEventStore` with the default pool, for a test that doesn't boot the module. Every store
 * it creates is independent of the others.
 *
 * @example
 * const { store, publisher } = await createInMemoryEventStore({ events: [AccountOpened] });
 * await store.appendEvents(stream, [new AccountOpened()], { expectedVersion: ExpectedVersion.NoStream });
 * expect(publisher.calls).toHaveLength(1);
 */
export const createInMemoryEventStore = async (
	options: TestEventStoreContextOptions = {},
): Promise<InMemoryTestEventStore> => {
	const context = createTestEventStoreContext(options);
	const store = new InMemoryEventStore(context, { driver: InMemoryEventStore });
	await store.connect();
	await store.ensureCollection();
	return { ...context, store };
};

/**
 * Creates a connected `InMemorySnapshotStore` with the default pool, for a test that doesn't boot the module.
 */
export const createInMemorySnapshotStore = async (): Promise<InMemorySnapshotStore> => {
	const store = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });
	await store.connect();
	await store.ensureCollection();
	return store;
};
