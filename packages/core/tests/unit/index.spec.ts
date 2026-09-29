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
		const eventStore = new EventSourcing.InMemoryEventStore(
			{ eventMap: new EventSourcing.EventMap(), publisher: { publishAll: async () => undefined } },
			{ driver: EventSourcing.InMemoryEventStore } satisfies EventSourcing.InMemoryEventStoreConfig,
		);
		const snapshotStore = new EventSourcing.InMemorySnapshotStore({
			driver: EventSourcing.InMemorySnapshotStore,
		} satisfies EventSourcing.InMemorySnapshotStoreConfig);

		expect(eventStore).toBeInstanceOf(EventSourcing.EventStore);
		expect(snapshotStore).toBeInstanceOf(EventSourcing.SnapshotStore);
	});

	it('does not expose internal helpers', () => {
		expect(
			Object.keys(EventSourcing).filter((key) =>
				/CommittedVersions|isSnapshotDue|bindStaticFactories|brandEventSourcingError|nameOf|describeValue|EVENT_SOURCING_ERROR|^validate/.test(
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
		expect(EventSourcing.assertEventStoreImplementation).toEqual(expect.any(Function));
	});

	it('keeps the internals of the module out of the exports', () => {
		// 3.x exported a static event registry, the explorer and the options token getter; the module discovers per
		// application now (ADR 0001 §3)
		expect(
			Object.keys(EventSourcing).filter((key) =>
				/EventRegistry|ExplorerService|getOptionsToken|CoreModule|FeatureModule|EventSourcingFeature|Registrar|Registration|ScopedHandler|planRegistration|Provider$|createCoreProviders|CORE_EXPORTS/.test(
					key,
				),
			),
		).toEqual([]);
		expect(EventSourcing.EventSourcingModule).toEqual(expect.any(Function));
		expect(EventSourcing.EventSourcingConfigurationException).toEqual(expect.any(Function));
		expect(EventSourcing.EventSourcingNotReadyException).toEqual(expect.any(Function));
	});

	it('keeps the internals of the store template out of the exports', () => {
		expect(
			Object.keys(EventSourcing).filter((key) =>
				/normalizeAppendArguments|LegacyEventStore|overriddenTemplateMethods|EVENT_STORE_BASE|PositionalAppend/.test(
					key,
				),
			),
		).toEqual([]);
	});
});
