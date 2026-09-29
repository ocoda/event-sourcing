import { Test } from '@nestjs/testing';
import {
	EventBus,
	type EventEnvelope,
	EventMap,
	EventSourcingModule,
	EventStore,
	type EventStoreContext,
	type EventStream,
	type IEvent,
	InMemoryEventStore,
	InvalidEventStoreImplementationException,
	type PersistOutcome,
	type PersistTarget,
	assertEventStoreImplementation,
} from '@ocoda/event-sourcing';
import { createTestContext, eventStreamAccountA, getEvents } from '@ocoda/event-sourcing-testing/unit';
import { EventStoreProvider } from '../../../lib/event-sourcing.providers.js';
import { EVENT_STORE_BASE } from '../../../lib/stores/implementation-guard.js';
import { StubEventStore } from './stub-event-store.js';

class OverridesGetEvent extends StubEventStore {
	override async getEvent(stream: EventStream, version: number): Promise<IEvent> {
		return super.getEvent(stream, version);
	}
}

class OverridesGetEventsFurtherDown extends OverridesGetEvent {
	override async *getEvents(): AsyncGenerator<IEvent[]> {}
}

class OverridesWithAField extends StubEventStore {
	getEvents = async function* (): AsyncGenerator<IEvent[]> {};
}

/** A store in the 3.x shape, which overrides appendEvents. */
class OverridesAppendEvents extends StubEventStore {
	override async appendEvents(): Promise<EventEnvelope[]> {
		return [];
	}
}

class ExtendsInMemoryAndOverridesAppendEvents extends InMemoryEventStore {
	override async appendEvents(): Promise<EventEnvelope[]> {
		return [];
	}
}

class DecoratesPersistEvents extends StubEventStore {
	readonly traced: number[] = [];

	protected override async persistEvents(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		this.traced.push(envelopes.length);
		return super.persistEvents(envelopes, target);
	}
}

const context = (): EventStoreContext => ({
	eventMap: new EventMap(),
	publisher: { publishAll: async () => undefined },
});

describe(assertEventStoreImplementation, () => {
	it('accepts a store that only implements the driver methods, also when it decorates persistEvents', () => {
		expect(() => assertEventStoreImplementation(new StubEventStore(context(), {}))).not.toThrow();
		expect(() => assertEventStoreImplementation(new DecoratesPersistEvents(context(), {}))).not.toThrow();
		expect(() => assertEventStoreImplementation(new InMemoryEventStore(context(), {} as never))).not.toThrow();
	});

	it.each([
		[OverridesAppendEvents, ['appendEvents']],
		[OverridesGetEvent, ['getEvent']],
		[OverridesGetEventsFurtherDown, ['getEvent', 'getEvents']],
		[OverridesWithAField, ['getEvents']],
	])('rejects %o, which overrides %o', (Store, methods) => {
		const store = new Store(context(), {});

		expect(() => assertEventStoreImplementation(store)).toThrow(InvalidEventStoreImplementationException);
		expect(() => assertEventStoreImplementation(store)).toThrow(
			expect.objectContaining({ store: Store.name, methods }),
		);
	});

	it('checks own properties set on the instance', () => {
		const store = new StubEventStore(context(), {});
		Object.defineProperty(store, 'appendEvents', { value: async () => [] });

		expect(() => assertEventStoreImplementation(store)).toThrow(expect.objectContaining({ methods: ['appendEvents'] }));
	});

	it('stops at the base class of another copy of the package', () => {
		// A base class with the template methods, marked like EventStore.prototype is
		class OtherCopyEventStore {
			appendEvents() {}
			getEvent() {}
			getEvents() {}
		}
		Object.defineProperty(OtherCopyEventStore.prototype, EVENT_STORE_BASE, { value: true });
		class Store extends OtherCopyEventStore {}

		expect(() => assertEventStoreImplementation(new Store() as never)).not.toThrow();
		expect(Object.hasOwn(EventStore.prototype, EVENT_STORE_BASE)).toBe(true);
	});

	it('lets a decorated persistEvents run through the template', async () => {
		const store = new DecoratesPersistEvents(createTestContext(), {});

		await store.appendEvents(eventStreamAccountA, getEvents().slice(0, 2), { expectedVersion: 0 });

		expect(store.traced).toEqual([2]);
		expect(store.stored).toHaveLength(2);
	});
});

describe('EventStoreProvider', () => {
	const eventMap = new EventMap();
	const eventBus = new EventBus();

	it('constructs the configured store with the store context and the driver options', async () => {
		const Driver = vi.fn(
			class extends StubEventStore {
				constructor(...args: ConstructorParameters<typeof StubEventStore>) {
					super(...args);
				}
			},
		);

		const connect = vi.spyOn(StubEventStore.prototype, 'connect');
		const ensureCollection = vi.spyOn(StubEventStore.prototype, 'ensureCollection');

		const store = await EventStoreProvider.useFactory(
			{ eventStore: { driver: Driver as never, useDefaultPool: false, host: 'db', port: 5432 } as never },
			eventMap,
			eventBus,
		);

		expect(Driver).toHaveBeenCalledWith({ eventMap, publisher: eventBus }, { host: 'db', port: 5432 });
		expect(store).toBeInstanceOf(StubEventStore);
		// Connected, without the default pool (useDefaultPool: false)
		expect(connect).toHaveBeenCalledTimes(1);
		expect(ensureCollection).not.toHaveBeenCalled();
		expect(EventStoreProvider.inject).toEqual([expect.any(String), EventMap, EventBus]);
	});

	it('uses the in-memory store by default, with the template methods of the base class', async () => {
		const store = await EventStoreProvider.useFactory({}, eventMap, eventBus);

		expect(store).toBeInstanceOf(InMemoryEventStore);
		expect(store.appendEvents).toBe(EventStore.prototype.appendEvents);
	});

	it.each([
		[OverridesGetEvent, ['getEvent']],
		[OverridesAppendEvents, ['appendEvents']],
		[ExtendsInMemoryAndOverridesAppendEvents, ['appendEvents']],
	])('fails for %o, which overrides %o', async (Store, methods) => {
		await expect(
			EventStoreProvider.useFactory({ eventStore: { driver: Store as never } }, eventMap, eventBus),
		).rejects.toThrow(expect.objectContaining({ name: 'InvalidEventStoreImplementationException', methods }));
	});

	it.each([OverridesWithAField, OverridesAppendEvents])('fails the bootstrap of a module with %o', async (Store) => {
		const bootstrap = Test.createTestingModule({
			imports: [EventSourcingModule.forRoot({ eventStore: { driver: Store as never } })],
		}).compile();

		await expect(bootstrap).rejects.toBeInstanceOf(InvalidEventStoreImplementationException);
	});
});
