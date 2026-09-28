import { Injectable, Logger, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
	EVENT_SOURCING_OPTIONS,
	EventSourcingModule,
	type EventSourcingModuleOptions,
	type EventSourcingOptionsFactory,
	EventStore,
	SnapshotStore,
} from '@ocoda/event-sourcing';
import { InMemoryEventStore } from '@ocoda/event-sourcing/integration/event-store';
import { InMemorySnapshotStore } from '@ocoda/event-sourcing/integration/snapshot-store';

describe('EventSourcingModule.forRootAsync (bootstrapped)', () => {
	@Injectable()
	class EventSourcingConfig {
		readonly useDefaultPool = true;
	}

	@Module({ providers: [EventSourcingConfig], exports: [EventSourcingConfig] })
	class EventSourcingConfigModule {}

	const createOptions = (config: EventSourcingConfig): EventSourcingModuleOptions => ({
		eventStore: { driver: InMemoryEventStore, useDefaultPool: config.useDefaultPool },
		snapshotStore: { driver: InMemorySnapshotStore, useDefaultPool: config.useDefaultPool },
	});

	/**
	 * An options factory with a dependency, to verify it is instantiated through DI.
	 */
	@Injectable()
	class EventSourcingOptionsService implements EventSourcingOptionsFactory {
		constructor(private readonly config: EventSourcingConfig) {}

		createEventSourcingOptions() {
			return createOptions(this.config);
		}
	}

	@Module({
		imports: [EventSourcingConfigModule],
		providers: [EventSourcingOptionsService],
		exports: [EventSourcingOptionsService],
	})
	class EventSourcingOptionsModule {}

	let moduleRef: TestingModule | undefined;

	const bootstrap = async (options: Parameters<typeof EventSourcingModule.forRootAsync>[0]) => {
		moduleRef = await Test.createTestingModule({ imports: [EventSourcingModule.forRootAsync(options)] }).compile();
		await moduleRef.init();
		return moduleRef;
	};

	const expectBootstrapped = async (app: TestingModule) => {
		const options = app.get<EventSourcingModuleOptions>(EVENT_SOURCING_OPTIONS);
		expect(options).toEqual(createOptions(new EventSourcingConfig()));

		const eventStore = app.get<InMemoryEventStore>(EventStore);
		const snapshotStore = app.get<InMemorySnapshotStore>(SnapshotStore);
		expect(eventStore).toBeInstanceOf(InMemoryEventStore);
		expect(snapshotStore).toBeInstanceOf(InMemorySnapshotStore);

		// the default pools were created on init
		expect([...eventStore.collections.keys()]).toEqual(['events']);
		expect([...snapshotStore.collections.keys()]).toEqual(['snapshots']);
	};

	beforeEach(() => {
		jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
	});

	afterEach(async () => {
		await moduleRef?.close();
		moduleRef = undefined;
		jest.restoreAllMocks();
	});

	it('bootstraps with useFactory', async () => {
		const app = await bootstrap({
			imports: [EventSourcingConfigModule],
			useFactory: (config: EventSourcingConfig) => createOptions(config),
			inject: [EventSourcingConfig],
		});

		await expectBootstrapped(app);
	});

	/**
	 * Captures the options factory instances that created the options.
	 */
	const spyOnOptionsFactories = () => {
		const factories: EventSourcingOptionsService[] = [];
		const original = EventSourcingOptionsService.prototype.createEventSourcingOptions;
		jest.spyOn(EventSourcingOptionsService.prototype, 'createEventSourcingOptions').mockImplementation(function (
			this: EventSourcingOptionsService,
		) {
			factories.push(this);
			return original.call(this);
		});
		return factories;
	};

	it('bootstraps with useClass', async () => {
		const factories = spyOnOptionsFactories();

		const app = await bootstrap({
			imports: [EventSourcingConfigModule],
			useClass: EventSourcingOptionsService,
		});

		await expectBootstrapped(app);
		// the options factory is instantiated by the module, with its dependencies injected from the imports
		expect(factories).toHaveLength(1);
		expect(factories[0]).toBeInstanceOf(EventSourcingOptionsService);
		expect((factories[0] as any).config).toBeInstanceOf(EventSourcingConfig);
	});

	it('bootstraps with useClass when an imported module already provides the options factory', async () => {
		// Before useClass instantiated the class itself, it only worked when one of the imports exported the class.
		// Its dependencies (EventSourcingConfig) aren't exported by EventSourcingOptionsModule, so the options factory
		// can't be instantiated in the event sourcing module: the provided instance has to be reused.
		const factories = spyOnOptionsFactories();

		const app = await bootstrap({
			imports: [EventSourcingOptionsModule],
			useClass: EventSourcingOptionsService,
		});

		await expectBootstrapped(app);
		expect(factories).toHaveLength(1);
		expect(factories[0]).toBe(app.select(EventSourcingOptionsModule).get(EventSourcingOptionsService));
	});

	it('bootstraps with useExisting', async () => {
		const app = await bootstrap({
			imports: [EventSourcingOptionsModule],
			useExisting: EventSourcingOptionsService,
		});

		await expectBootstrapped(app);
		// the existing provider is reused
		expect(app.get(EventSourcingOptionsService, { strict: false })).toBe(
			app.select(EventSourcingOptionsModule).get(EventSourcingOptionsService),
		);
	});

	it('bootstraps with useValue', async () => {
		const app = await bootstrap({ useValue: createOptions(new EventSourcingConfig()) });

		await expectBootstrapped(app);
	});

	it('throws a descriptive error when no options provider is configured', () => {
		expect(() => EventSourcingModule.forRootAsync({ imports: [EventSourcingConfigModule] })).toThrow(
			'Invalid EventSourcingModule.forRootAsync() options: provide one of "useFactory", "useClass", "useExisting" or "useValue".',
		);
	});
});
