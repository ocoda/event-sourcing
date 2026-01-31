import { DiscoveryModule } from '@nestjs/core';
import { EVENT_SOURCING_OPTIONS, EventSourcingModule } from '@ocoda/event-sourcing';
import { EventSourcingCoreModule } from '../../lib/event-sourcing.core.module';
import {
	createAsyncEventSourcingOptionsProvider,
	createEventSourcingOptionsProvider,
} from '../../lib/event-sourcing.providers';
import { InMemoryEventStore } from '../../lib/integration/event-store';
import { InMemorySnapshotStore } from '../../lib/integration/snapshot-store';
import { EventRegistry } from '../../lib/registries/event.registry';

describe(EventSourcingModule, () => {
	class TestEvent {}

	it('registers feature modules with events', () => {
		const dynamicModule = EventSourcingModule.forFeature({ events: [TestEvent as any] });

		expect(dynamicModule.module).toBeDefined();
		expect(dynamicModule.imports).toEqual([DiscoveryModule]);
		expect(EventRegistry.getEvents()).toContain(TestEvent as any);
	});

	it('creates a core module with providers', () => {
		const dynamicModule = EventSourcingModule.forRoot({});

		expect(dynamicModule.module).toBe(EventSourcingModule);
		expect((dynamicModule.imports?.[0] as any)?.module).toBe(EventSourcingCoreModule);
		expect(dynamicModule.exports).toContain(EventSourcingCoreModule);
	});

	it('creates an async core module with imports', () => {
		const dynamicModule = EventSourcingModule.forRootAsync({
			imports: [DiscoveryModule],
			useValue: {},
		});

		expect(dynamicModule.module).toBe(EventSourcingModule);
		expect(dynamicModule.imports?.[0]).toBe(DiscoveryModule);
		expect(dynamicModule.providers?.length).toBe(0);
		expect(dynamicModule.exports).toContain(EventSourcingCoreModule);
	});
});

describe('EventSourcing options providers', () => {
	it('creates a sync options provider', () => {
		const providers = createEventSourcingOptionsProvider({});
		const provider = providers[0] as any;

		expect(provider.provide).toBe(EVENT_SOURCING_OPTIONS);
		expect(provider.useValue).toEqual({});
	});

	it('creates async options provider from useValue', () => {
		const providers = createAsyncEventSourcingOptionsProvider({
			useValue: { eventStore: { driver: InMemoryEventStore, useDefaultPool: false } },
		});

		expect(providers).toHaveLength(1);
		expect((providers[0] as any).provide).toBe(EVENT_SOURCING_OPTIONS);
		expect((providers[0] as any).useValue).toEqual({
			eventStore: { driver: InMemoryEventStore, useDefaultPool: false },
		});
	});

	it('creates async options provider from useFactory', () => {
		const factory = () => ({ snapshotStore: { driver: InMemorySnapshotStore, useDefaultPool: false } });
		const providers = createAsyncEventSourcingOptionsProvider({ useFactory: factory });

		expect((providers[0] as any).provide).toBe(EVENT_SOURCING_OPTIONS);
		expect((providers[0] as any).useFactory).toBe(factory);
		expect((providers[0] as any).inject).toEqual([]);
	});

	it('creates async options provider from useExisting', async () => {
		class OptionsFactory {
			createEventSourcingOptions() {
				return { eventStore: { driver: InMemoryEventStore, useDefaultPool: true } };
			}
		}

		const providers = createAsyncEventSourcingOptionsProvider({ useExisting: OptionsFactory });
		const provider = providers[0] as any;
		const resolved = await provider.useFactory?.(new OptionsFactory());

		expect(provider.inject).toEqual([OptionsFactory]);
		expect(resolved).toEqual({ eventStore: { driver: InMemoryEventStore, useDefaultPool: true } });
	});

	it('creates async options provider from useClass', async () => {
		class OptionsFactory {
			createEventSourcingOptions() {
				return { snapshotStore: { driver: InMemorySnapshotStore, useDefaultPool: true } };
			}
		}

		const providers = createAsyncEventSourcingOptionsProvider({ useClass: OptionsFactory });
		const provider = providers[0] as any;
		const resolved = await provider.useFactory?.(new OptionsFactory());

		expect(provider.inject).toEqual([OptionsFactory]);
		expect(resolved).toEqual({ snapshotStore: { driver: InMemorySnapshotStore, useDefaultPool: true } });
	});

	it('registers feature modules without events', () => {
		const dynamicModule = EventSourcingModule.forFeature();

		expect(dynamicModule.imports).toEqual([DiscoveryModule]);
	});

	it('exposes core module providers', () => {
		const moduleDef = EventSourcingCoreModule.forRoot({});
		const hasOptions = (moduleDef.providers ?? []).some(
			(provider) =>
				typeof provider === 'object' && 'provide' in provider && provider.provide === EVENT_SOURCING_OPTIONS,
		);

		expect(hasOptions).toBe(true);
	});
});
