import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
	CommandBus,
	EventBus,
	EventMap,
	type EventSourcingModuleOptions,
	EventStore,
	QueryBus,
	SnapshotStore,
} from '@ocoda/event-sourcing';
import { AccountRepository, OpenAccountCommandHandler } from '@ocoda/event-sourcing-testing/e2e/application';
import { AccountSnapshotRepository } from '@ocoda/event-sourcing-testing/e2e/domain';
import { eventStreamAccountA, getEventMap, getEvents } from '@ocoda/event-sourcing-testing/unit';
import { InMemoryEventStore } from '@ocoda/event-sourcing/integration/event-store';
import { ExplorerService } from '@ocoda/event-sourcing/services';
import { EventSourcingCoreModule } from '../../lib/event-sourcing.core.module';

// Nest resolves constructor dependencies from `design:paramtypes`. The tests are transformed by Vite's Oxc
// (not tsc or SWC), so these guard that it emits legacy decorators with that metadata for the library, the
// spec files and the shared testing package alike.
const paramTypes = (target: object): unknown[] | undefined => Reflect.getMetadata('design:paramtypes', target);

@Injectable()
class SpecLocalConsumer {
	constructor(
		readonly eventBus: EventBus,
		readonly eventMap: EventMap,
		readonly label: string,
		readonly options: EventSourcingModuleOptions,
	) {}
}

@Injectable()
class SpecLocalService {
	constructor(
		readonly eventBus: EventBus,
		readonly eventMap: EventMap,
	) {}
}

describe('decorator metadata', () => {
	it('is emitted for library providers with constructor injection', () => {
		// Interfaces (the injected module options) have no runtime value and are emitted as Object.
		expect(paramTypes(EventSourcingCoreModule)).toEqual([
			Object,
			QueryBus,
			EventBus,
			EventMap,
			CommandBus,
			EventStore,
			SnapshotStore,
			ExplorerService,
		]);
		expect(paramTypes(ExplorerService)).toEqual([Object, DiscoveryService]);
	});

	it('is emitted for classes declared in a spec file', () => {
		expect(paramTypes(SpecLocalConsumer)).toEqual([EventBus, EventMap, String, Object]);
	});

	it('is emitted for classes from the shared testing package', () => {
		expect(paramTypes(AccountRepository)).toEqual([EventStore, AccountSnapshotRepository]);
		expect(paramTypes(OpenAccountCommandHandler)).toEqual([AccountRepository]);
	});

	it('lets Nest inject dependencies by type', async () => {
		const moduleRef = await Test.createTestingModule({ providers: [EventBus, EventMap, SpecLocalService] }).compile();

		const service = moduleRef.get(SpecLocalService);

		expect(service.eventBus).toBe(moduleRef.get(EventBus));
		expect(service.eventMap).toBe(moduleRef.get(EventMap));
	});
});

// The shared tsconfig sets useDefineForClassFields: false, which Oxc mirrors for the tests. The EventStore
// constructor returns a Proxy that wraps appendEvents to publish, reading `_publish`, a field that is declared
// without an initializer and only assigned through the `publish` setter.
describe('EventStore publish wiring (useDefineForClassFields: false)', () => {
	const events = getEvents();
	let eventStore: InMemoryEventStore;

	beforeEach(async () => {
		eventStore = new InMemoryEventStore(getEventMap(), { driver: InMemoryEventStore });
		await eventStore.connect();
		await eventStore.ensureCollection();
	});

	afterEach(async () => {
		await eventStore.disconnect();
	});

	it('does not define class fields without an initializer', () => {
		const store = new InMemoryEventStore(getEventMap(), { driver: InMemoryEventStore });

		// With define semantics these would be own properties initialised to undefined.
		expect(Object.hasOwn(store, '_publish')).toBe(false);
		expect(Object.hasOwn(store, 'collections')).toBe(false);
		// Fields with an initializer are still assigned in the constructor.
		expect(Object.hasOwn(store, 'logger')).toBe(true);
	});

	it('publishes every appended envelope through the function set on the proxy', async () => {
		const publish = vi.fn();
		eventStore.publish = publish;

		// The setter ran against the proxied instance.
		expect((eventStore as unknown as { _publish: unknown })._publish).toBe(publish);

		const envelopes = await eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3));

		expect(envelopes).toHaveLength(3);
		expect(publish.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));
		expect(publish.mock.contexts).toEqual([eventStore, eventStore, eventStore]);
	});

	it('uses the publish function that is set at the time of the append', async () => {
		const first = vi.fn();
		const second = vi.fn();

		eventStore.publish = first;
		await eventStore.appendEvents(eventStreamAccountA, 1, events.slice(0, 1));
		eventStore.publish = second;
		await eventStore.appendEvents(eventStreamAccountA, 2, events.slice(1, 2));

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});
});
