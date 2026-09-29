import {
	Aggregate,
	AggregateRoot,
	Event,
	EventMap,
	EventStream,
	ExpectedVersion,
	type IEvent,
	type IEventSerializer,
	InMemoryEventStore,
	InMemorySnapshotStore,
	SnapshotStream,
	UUID,
} from '@ocoda/event-sourcing';
import {
	RecordingPublisher,
	createInMemoryEventStore,
	createInMemorySnapshotStore,
	createTestEventStoreContext,
} from '@ocoda/event-sourcing/testing';

class TestId extends UUID {}

@Aggregate({ streamName: 'testing-helper' })
class Helper extends AggregateRoot {}

@Event('testing-helper-created')
class HelperCreated implements IEvent {
	constructor(public readonly name: string) {}
}

@Event('testing-helper-renamed')
class HelperRenamed implements IEvent {
	constructor(public readonly name: string) {}
}

describe('@ocoda/event-sourcing/testing helpers', () => {
	describe(createTestEventStoreContext, () => {
		it('registers the events with the default serializer and records what is published', () => {
			const { eventMap, publisher } = createTestEventStoreContext({ events: [HelperCreated] });

			expect(eventMap.getName(HelperCreated)).toBe('testing-helper-created');
			expect(eventMap.deserializeEvent('testing-helper-created', { name: 'a' })).toEqual(new HelperCreated('a'));
			expect(eventMap.has(HelperRenamed)).toBe(false);
			expect(publisher).toBeInstanceOf(RecordingPublisher);
			expect(publisher.calls).toEqual([]);
		});

		it('registers the events in the given event map, next to the events it holds', () => {
			const eventMap = new EventMap();
			const serializer: IEventSerializer<HelperRenamed> = {
				serialize: ({ name }) => ({ renamedTo: name }) as never,
				deserialize: (payload) => new HelperRenamed((payload as unknown as { renamedTo: string }).renamedTo),
			};
			eventMap.register(HelperRenamed, serializer);

			const context = createTestEventStoreContext({ events: [HelperCreated], eventMap });

			expect(context.eventMap).toBe(eventMap);
			expect(eventMap.serializeEvent(new HelperRenamed('b'))).toEqual({ renamedTo: 'b' });
			expect(eventMap.serializeEvent(new HelperCreated('c'))).toEqual({ name: 'c' });
		});

		it('creates an empty event map by default', () => {
			expect(createTestEventStoreContext().eventMap.has(HelperCreated)).toBe(false);
		});
	});

	describe(createInMemoryEventStore, () => {
		it('creates a connected store with the default pool, which publishes to a recording publisher', async () => {
			const { store, publisher, eventMap } = await createInMemoryEventStore({ events: [HelperCreated, HelperRenamed] });
			const stream = EventStream.for(Helper, TestId.generate());

			expect(store).toBeInstanceOf(InMemoryEventStore);
			expect(eventMap.has(HelperRenamed)).toBe(true);

			const appended = await store.appendEvents(stream, [new HelperCreated('a'), new HelperRenamed('b')], {
				expectedVersion: ExpectedVersion.NoStream,
			});

			expect(appended.map(({ metadata }) => metadata.version)).toEqual([1, 2]);
			expect(publisher.calls).toEqual([appended]);
			const events: IEvent[] = [];
			for await (const batch of store.getEvents(stream)) {
				events.push(...batch);
			}
			expect(events).toEqual([new HelperCreated('a'), new HelperRenamed('b')]);
		});

		it('creates independent stores', async () => {
			const first = await createInMemoryEventStore({ events: [HelperCreated] });
			const second = await createInMemoryEventStore({ events: [HelperCreated] });
			const stream = EventStream.for(Helper, TestId.generate());

			await first.store.appendEvents(stream, [new HelperCreated('a')], { expectedVersion: ExpectedVersion.NoStream });

			await expect(second.store.getStreamVersion(stream)).resolves.toBe(0);
			expect(second.publisher.calls).toEqual([]);
		});
	});

	describe(createInMemorySnapshotStore, () => {
		it('creates a connected store with the default pool', async () => {
			const store = await createInMemorySnapshotStore();
			const stream = SnapshotStream.for(Helper, TestId.generate());

			expect(store).toBeInstanceOf(InMemorySnapshotStore);
			await store.appendSnapshot(stream, 1, { name: 'a' });
			await expect(store.getLastSnapshot(stream)).resolves.toEqual({ name: 'a' });
		});
	});
});
