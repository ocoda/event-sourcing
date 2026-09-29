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
		expect(
			Object.keys(EventSourcing).filter((key) =>
				/CommittedVersions|isSnapshotDue|brandEventSourcingError|nameOf|describeValue|EVENT_SOURCING_ERROR|^validate/.test(
					key,
				),
			),
		).toEqual([]);
	});

	it('exports the helpers and constants of the store contract', () => {
		expect(EventSourcing.ANY_MAX_ATTEMPTS).toBe(16);
		expect(EventSourcing.EVENT_STORE_LIMITS.headersBytes).toBe(8192);
		expect(EventSourcing.DEFAULT_EVENT_STORE_CAPABILITIES.globalOrder).toBe('best-effort');
		expect(EventSourcing.resolveCapabilities).toEqual(expect.any(Function));
		expect(EventSourcing.toPosition).toEqual(expect.any(Function));
	});
});
