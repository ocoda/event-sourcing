import { Injectable } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
	CommandBus,
	EventBus,
	EventMap,
	EventSourcingModule,
	type EventSourcingModuleOptions,
	EventStore,
	type IEvent,
	InvalidEventStoreImplementationException,
	QueryBus,
	assertEventStoreImplementation,
} from '@ocoda/event-sourcing';
import { AccountRepository, OpenAccountCommandHandler } from '@ocoda/event-sourcing-testing/e2e/application';
import { AccountSnapshotRepository } from '@ocoda/event-sourcing-testing/e2e/domain';
import { createTestContext } from '@ocoda/event-sourcing-testing/unit';
import { InMemoryEventStore } from '@ocoda/event-sourcing/integration/event-store';
import { EventSourcingRegistrar } from '../../lib/registration/registrar.js';

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
		// Interfaces (the injected module options, the registration) have no runtime value and are emitted as Object.
		expect(paramTypes(EventSourcingModule)).toEqual([Object]);
		expect(paramTypes(EventSourcingRegistrar)).toEqual([DiscoveryService, ModuleRef, Object]);
		expect(paramTypes(CommandBus)).toEqual([ModuleRef, Object]);
		expect(paramTypes(QueryBus)).toEqual([ModuleRef, Object]);
		expect(paramTypes(EventMap)).toEqual([Object]);
		expect(paramTypes(EventBus)).toEqual([Object, Object]);
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

// The shared tsconfig keeps define semantics for class fields (useDefineForClassFields: true), matching the
// published build, and Oxc mirrors it for the tests. The event store's implementation guard relies on it: a template
// method that a store overrides with a class field is an own property of the store.
describe('class fields (define semantics)', () => {
	it('defines class fields without an initializer, like the published build', () => {
		const store = new InMemoryEventStore(createTestContext(), { driver: InMemoryEventStore });

		// Define semantics: fields declared without an initializer are own properties initialised to undefined.
		expect(Object.hasOwn(store, 'collections')).toBe(true);
		expect(store.collections).toBeUndefined();
		// Fields with an initializer are still assigned in the constructor.
		expect(Object.hasOwn(store, 'logger')).toBe(true);
	});

	it('makes a template method overridden by a class field an own property, which the guard rejects', () => {
		class FieldOverride extends InMemoryEventStore {
			getEvent = async (): Promise<IEvent> => ({});
		}
		const store = new FieldOverride(createTestContext(), { driver: InMemoryEventStore });

		expect(Object.hasOwn(store, 'getEvent')).toBe(true);
		expect(() => assertEventStoreImplementation(store)).toThrow(InvalidEventStoreImplementationException);
	});
});
