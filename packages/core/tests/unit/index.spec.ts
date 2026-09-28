import * as EventSourcing from '@ocoda/event-sourcing';
import * as InMemoryStores from '@ocoda/event-sourcing/integration';

describe('public entrypoint', () => {
	it('exports the in-memory event- and snapshot-store', () => {
		expect(EventSourcing.InMemoryEventStore).toBe(InMemoryStores.InMemoryEventStore);
		expect(EventSourcing.InMemorySnapshotStore).toBe(InMemoryStores.InMemorySnapshotStore);
		expect(Object.getPrototypeOf(EventSourcing.InMemoryEventStore)).toBe(EventSourcing.EventStore);
		expect(Object.getPrototypeOf(EventSourcing.InMemorySnapshotStore)).toBe(EventSourcing.SnapshotStore);
	});

	it('can use the exported in-memory stores as drivers', async () => {
		const eventStore = new EventSourcing.InMemoryEventStore(new EventSourcing.EventMap(), {
			driver: EventSourcing.InMemoryEventStore,
		} satisfies EventSourcing.InMemoryEventStoreConfig);
		const snapshotStore = new EventSourcing.InMemorySnapshotStore({
			driver: EventSourcing.InMemorySnapshotStore,
		} satisfies EventSourcing.InMemorySnapshotStoreConfig);

		expect(eventStore).toBeInstanceOf(EventSourcing.EventStore);
		expect(snapshotStore).toBeInstanceOf(EventSourcing.SnapshotStore);
	});

	it('does not expose internal helpers', () => {
		expect(Object.keys(EventSourcing).filter((key) => /CommittedVersions|isSnapshotDue/.test(key))).toEqual([]);
	});
});
