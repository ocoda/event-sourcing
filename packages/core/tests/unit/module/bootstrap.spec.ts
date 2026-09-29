import {
	Global,
	Inject,
	Injectable,
	Logger,
	Module,
	type ModuleMetadata,
	type OnModuleInit,
	type Provider,
	Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import {
	Aggregate,
	AggregateRoot,
	Command,
	CommandBus,
	CommandHandler,
	Event,
	EventBus,
	EventEnvelope,
	EventMap,
	EventPublisher,
	EventSerializer,
	EventSourcingModule,
	EventSourcingNotReadyException,
	EventStore,
	type EventStoreConfig,
	type EventStoreContext,
	EventStream,
	EventSubscriber,
	type ICommandHandler,
	type IEvent,
	type IEventPayload,
	type IEventPublisher,
	type IEventSerializer,
	type IEventSubscriber,
	InMemoryEventStore,
	InMemorySnapshotStore,
	type IQueryHandler,
	InvalidEventStoreImplementationException,
	Query,
	QueryBus,
	QueryHandler,
	SnapshotStore,
	type SnapshotStoreConfig,
	UUID,
} from '@ocoda/event-sourcing';
import { EventSourcingRegistrar } from '../../../lib/registration/registrar.js';

// ---- domain -----------------------------------------------------------------------------------------------------

@Aggregate({ streamName: 'bootstrap-account' })
class Account extends AggregateRoot {}

@Event('bootstrap-account-opened')
class AccountOpenedEvent implements IEvent {
	constructor(readonly owner = 'owner') {}
}

@Event('bootstrap-feature-a')
class FeatureAEvent implements IEvent {}

@Event('bootstrap-feature-b')
class FeatureBEvent implements IEvent {}

class PingCommand extends Command<string> {}
class PingQuery extends Query<string> {}
class FailingCommand extends Command<void> {}

const streamOf = (id = UUID.generate()) => EventStream.for(Account, id);
const open = (store: EventStore, stream = streamOf()) =>
	store.appendEvents(stream, [new AccountOpenedEvent()], { expectedVersion: 0 });

// ---- helpers ----------------------------------------------------------------------------------------------------

const apps: TestingModule[] = [];

const compile = async (metadata: ModuleMetadata): Promise<TestingModule> => {
	const app = await Test.createTestingModule(metadata).compile();
	apps.push(app);
	return app;
};

const bootstrap = async (metadata: ModuleMetadata): Promise<TestingModule> => {
	const app = await compile(metadata);
	await app.init();
	return app;
};

const failure = async (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => {
			throw new Error('expected a failure');
		},
		(error: unknown) => error,
	);

beforeEach(() => {
	vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
	vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(async () => {
	for (const app of apps.splice(0)) {
		await app.close().catch(() => undefined);
	}
});

// ---- forRoot and forRootAsync -----------------------------------------------------------------------------------

describe('forRoot and forRootAsync', () => {
	/**
	 * An event store that records the options it was created with.
	 */
	class RecordingEventStore extends InMemoryEventStore {
		static readonly created: unknown[] = [];

		constructor(context: EventStoreContext, options: never) {
			super(context, options);
			RecordingEventStore.created.push(options);
		}
	}
	class RecordingSnapshotStore extends InMemorySnapshotStore {
		static readonly created: unknown[] = [];

		constructor(options: never) {
			super(options);
			RecordingSnapshotStore.created.push(options);
		}
	}
	interface RecordingEventStoreConfig extends EventStoreConfig {
		driver: typeof RecordingEventStore;
		label: string;
	}
	interface RecordingSnapshotStoreConfig extends SnapshotStoreConfig {
		driver: typeof RecordingSnapshotStore;
		label: string;
	}

	beforeEach(() => {
		RecordingEventStore.created.length = 0;
		RecordingSnapshotStore.created.length = 0;
	});

	it('defaults to connected in-memory stores with their default pools', async () => {
		const app = await bootstrap({ imports: [EventSourcingModule.forRoot({})] });

		const eventStore = app.get<InMemoryEventStore>(EventStore);
		const snapshotStore = app.get<InMemorySnapshotStore>(SnapshotStore);
		expect(eventStore).toBeInstanceOf(InMemoryEventStore);
		expect(snapshotStore).toBeInstanceOf(InMemorySnapshotStore);
		expect([...eventStore.collections.keys()]).toEqual(['events']);
		expect([...snapshotStore.collections.keys()]).toEqual(['snapshots']);
	});

	it('connects the stores while the providers are instantiated, before any lifecycle hook', async () => {
		const app = await compile({ imports: [EventSourcingModule.forRoot({})] });

		// Not initialised: the stores are already connected and usable
		expect([...app.get<InMemoryEventStore>(EventStore).collections.keys()]).toEqual(['events']);
	});

	it('hands the drivers their options without driver and useDefaultPool, typed by the configs', async () => {
		const app = await bootstrap({
			imports: [
				EventSourcingModule.forRoot<RecordingEventStoreConfig, RecordingSnapshotStoreConfig>({
					eventStore: { driver: RecordingEventStore, useDefaultPool: false, label: 'events' },
					snapshotStore: { driver: RecordingSnapshotStore, useDefaultPool: false, label: 'snapshots' },
				}),
			],
		});

		expect(RecordingEventStore.created).toEqual([{ label: 'events' }]);
		expect(RecordingSnapshotStore.created).toEqual([{ label: 'snapshots' }]);
		// useDefaultPool: false creates no default pool
		expect(app.get<RecordingEventStore>(EventStore).collections.size).toBe(0);
		expect(app.get<RecordingSnapshotStore>(SnapshotStore).collections.size).toBe(0);

		// The generics type the driver options
		EventSourcingModule.forRoot<RecordingEventStoreConfig>({
			// @ts-expect-error label must be a string
			eventStore: { driver: RecordingEventStore, label: 1 },
		});
	});

	it.each([
		['useFactory', { useFactory: async () => ({ eventStore: { driver: RecordingEventStore, label: 'async' } }) }],
		['useValue (deprecated)', { useValue: { eventStore: { driver: RecordingEventStore, label: 'async' } } }],
	])('creates the stores from the options of forRootAsync with %s', async (_, options) => {
		const app = await bootstrap({
			imports: [EventSourcingModule.forRootAsync<RecordingEventStoreConfig>(options as never)],
		});

		expect(app.get(EventStore)).toBeInstanceOf(RecordingEventStore);
		expect(RecordingEventStore.created).toEqual([{ label: 'async' }]);
	});

	it('fails the bootstrap when a store fails to connect, and disconnects it', async () => {
		const cause = new Error('connection refused');
		const connect = vi.spyOn(InMemoryEventStore.prototype, 'connect').mockRejectedValue(cause);
		const disconnect = vi.spyOn(InMemoryEventStore.prototype, 'disconnect');

		expect(await failure(compile({ imports: [EventSourcingModule.forRoot({})] }))).toBe(cause);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it('fails the bootstrap when the default pool of a store can not be created, and disconnects it', async () => {
		const cause = new Error('needs a migration');
		vi.spyOn(InMemorySnapshotStore.prototype, 'ensureCollection').mockRejectedValue(cause);
		const disconnect = vi.spyOn(InMemorySnapshotStore.prototype, 'disconnect');

		expect(await failure(compile({ imports: [EventSourcingModule.forRoot({})] }))).toBe(cause);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it('still fails with the connection error when disconnecting the failed store fails too', async () => {
		const cause = new Error('connection refused');
		vi.spyOn(InMemoryEventStore.prototype, 'connect').mockRejectedValue(cause);
		vi.spyOn(InMemoryEventStore.prototype, 'disconnect').mockRejectedValue(new Error('not connected'));
		const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

		expect(await failure(compile({ imports: [EventSourcingModule.forRoot({})] }))).toBe(cause);
		expect(error).toHaveBeenCalledWith(
			'Failed to disconnect the eventStore after it failed to start',
			expect.any(Error),
		);
	});

	it('fails the bootstrap with an event store that overrides a template method', async () => {
		class OverridingEventStore extends InMemoryEventStore {
			override async getEvent(): Promise<IEvent> {
				return new AccountOpenedEvent();
			}
		}
		const connect = vi.spyOn(OverridingEventStore.prototype, 'connect');

		const error = await failure(
			compile({ imports: [EventSourcingModule.forRoot({ eventStore: { driver: OverridingEventStore } })] }),
		);

		expect(error).toBeInstanceOf(InvalidEventStoreImplementationException);
		expect(connect).not.toHaveBeenCalled();
	});

	it('disconnects each store once, after the event bus has drained, when the application shuts down', async () => {
		const order: string[] = [];
		const whenIdle = EventBus.prototype.whenIdle;
		vi.spyOn(EventBus.prototype, 'whenIdle').mockImplementation(async function (this: EventBus, options) {
			await whenIdle.call(this, options);
			order.push('drained');
		});
		const eventStoreDisconnect = vi.spyOn(InMemoryEventStore.prototype, 'disconnect');
		const snapshotStoreDisconnect = vi.spyOn(InMemorySnapshotStore.prototype, 'disconnect');
		eventStoreDisconnect.mockImplementation(async () => {
			order.push('event store disconnected');
		});
		snapshotStoreDisconnect.mockImplementation(async () => {
			order.push('snapshot store disconnected');
		});
		const app = await bootstrap({ imports: [EventSourcingModule.forRoot({})] });

		await app.close();
		apps.splice(apps.indexOf(app), 1);

		expect(order[0]).toBe('drained');
		expect(order.slice(1).sort()).toEqual(['event store disconnected', 'snapshot store disconnected']);
		expect(eventStoreDisconnect).toHaveBeenCalledTimes(1);
		expect(snapshotStoreDisconnect).toHaveBeenCalledTimes(1);
	});

	it('logs a store that fails to disconnect and shuts down anyway', async () => {
		vi.spyOn(InMemoryEventStore.prototype, 'disconnect').mockRejectedValue(new Error('event store gone'));
		vi.spyOn(InMemorySnapshotStore.prototype, 'disconnect').mockRejectedValue('snapshot store gone');
		const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		const app = await bootstrap({ imports: [EventSourcingModule.forRoot({})] });

		await expect(app.close()).resolves.toBeUndefined();
		apps.splice(apps.indexOf(app), 1);

		expect(error).toHaveBeenCalledWith(
			'Failed to disconnect the event store',
			expect.stringContaining('event store gone'),
		);
		expect(error).toHaveBeenCalledWith('Failed to disconnect the snapshot store', 'snapshot store gone');
	});

	describe('in production', () => {
		beforeEach(() => {
			vi.stubEnv('NODE_ENV', 'production');
		});
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('warns about in-memory stores that were not configured', async () => {
			const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

			await bootstrap({ imports: [EventSourcingModule.forRoot({})] });

			expect(warn).toHaveBeenCalledWith(expect.stringContaining('No eventStore is configured'));
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('No snapshotStore is configured'));
		});

		it('does not warn about stores that were configured, in-memory ones included', async () => {
			const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

			await bootstrap({
				imports: [
					EventSourcingModule.forRoot({
						eventStore: { driver: InMemoryEventStore },
						snapshotStore: { driver: InMemorySnapshotStore },
					}),
				],
			});

			expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is configured'));
		});
	});

	it('does not warn about implicit in-memory stores outside production', async () => {
		vi.stubEnv('NODE_ENV', 'development');
		const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

		try {
			await bootstrap({ imports: [EventSourcingModule.forRoot({})] });
		} finally {
			vi.unstubAllEnvs();
		}

		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is configured'));
	});
});

// ---- forFeature -------------------------------------------------------------------------------------------------

describe('forFeature', () => {
	@EventSerializer(FeatureAEvent)
	class FeatureASerializer implements IEventSerializer<FeatureAEvent> {
		constructor(@Inject('PREFIX') private readonly prefix: string) {}
		serialize(): IEventPayload<FeatureAEvent> {
			return { serializedBy: this.prefix } as unknown as IEventPayload<FeatureAEvent>;
		}
		deserialize(): FeatureAEvent {
			return new FeatureAEvent();
		}
	}

	@Module({ providers: [{ provide: 'PREFIX', useValue: 'feature-a' }], exports: ['PREFIX'] })
	class PrefixModule {}

	@Module({
		imports: [
			EventSourcingModule.forFeature({
				events: [FeatureAEvent],
				serializers: [FeatureASerializer],
				imports: [PrefixModule],
			}),
		],
	})
	class FeatureAModule {}

	@Module({ imports: [EventSourcingModule.forFeature({ events: [FeatureBEvent] })] })
	class FeatureBModule {}

	it('registers the events of every feature module, with their serializers', async () => {
		const app = await bootstrap({
			imports: [EventSourcingModule.forRoot({ events: [AccountOpenedEvent] }), FeatureAModule, FeatureBModule],
		});
		const eventMap = app.get(EventMap);

		expect(eventMap.getName(AccountOpenedEvent)).toBe('bootstrap-account-opened');
		expect(eventMap.getName(FeatureAEvent)).toBe('bootstrap-feature-a');
		expect(eventMap.getName(FeatureBEvent)).toBe('bootstrap-feature-b');
		// The serializer of the feature module, with a dependency from the feature's imports
		expect(eventMap.serializeEvent(new FeatureAEvent())).toEqual({ serializedBy: 'feature-a' });
	});

	it('keeps the events of two applications in one process apart', async () => {
		const withFeature = await bootstrap({ imports: [EventSourcingModule.forRoot({}), FeatureBModule] });
		const withoutFeature = await bootstrap({ imports: [EventSourcingModule.forRoot({})] });

		expect(withFeature.get(EventMap).has(FeatureBEvent)).toBe(true);
		expect(withoutFeature.get(EventMap).has(FeatureBEvent)).toBe(false);
		expect(withFeature.get(EventStore)).not.toBe(withoutFeature.get(EventStore));

		// Closing one leaves the other working
		await withFeature.close();
		apps.splice(apps.indexOf(withFeature), 1);
		await expect(open(withoutFeature.get(EventStore))).rejects.toMatchObject({ code: 'ES_UNREGISTERED_EVENT' });
		expect(withoutFeature.get(EventMap).has(FeatureBEvent)).toBe(false);
	});

	it('registers the same feature module in two applications, one after the other', async () => {
		for (let run = 0; run < 2; run++) {
			const app = await bootstrap({ imports: [EventSourcingModule.forRoot({}), FeatureBModule] });
			expect(app.get(EventMap).getName(FeatureBEvent)).toBe('bootstrap-feature-b');
			await app.close();
			apps.splice(apps.indexOf(app), 1);
		}
	});
});

// ---- registration -----------------------------------------------------------------------------------------------

describe('registration', () => {
	const delivered: string[] = [];
	const hooks: string[] = [];

	@EventPublisher()
	class RecordingPublisher implements IEventPublisher {
		publish(envelope: EventEnvelope) {
			delivered.push(`publisher:${envelope.metadata.aggregateId}`);
		}
	}

	@EventSubscriber(AccountOpenedEvent)
	class RecordingSubscriber implements IEventSubscriber {
		handle(envelope: EventEnvelope) {
			delivered.push(`subscriber:${envelope.metadata.aggregateId}`);
		}
	}

	const globalId = UUID.generate();
	const deepId = UUID.generate();

	@Injectable()
	class GlobalSeeder implements OnModuleInit {
		constructor(private readonly eventStore: EventStore) {}
		async onModuleInit() {
			hooks.push('user global module');
			await open(this.eventStore, streamOf(globalId));
		}
	}

	@Global()
	@Module({ providers: [GlobalSeeder] })
	class UserGlobalModule {}

	@Injectable()
	class DeepSeeder implements OnModuleInit {
		constructor(private readonly eventStore: EventStore) {}
		async onModuleInit() {
			hooks.push('depth-4 module');
			await open(this.eventStore, streamOf(deepId));
		}
	}

	@Module({ providers: [DeepSeeder] })
	class Depth4Module {}
	@Module({ imports: [Depth4Module] })
	class Depth3Module {}
	@Module({ imports: [Depth3Module] })
	class Depth2Module {}
	@Module({ imports: [Depth2Module] })
	class Depth1Module {}

	beforeEach(() => {
		delivered.length = 0;
		hooks.length = 0;
	});

	it('delivers the appends of a user @Global() module and of a depth-4 module from their onModuleInit', async () => {
		const initialize = EventSourcingRegistrar.prototype.initialize;
		vi.spyOn(EventSourcingRegistrar.prototype, 'initialize').mockImplementation(function (
			this: EventSourcingRegistrar,
		) {
			hooks.push('event sourcing module');
			initialize.call(this);
		});

		const app = await bootstrap({
			// The user's global module ties with the event sourcing module and runs its hooks first
			imports: [UserGlobalModule, EventSourcingModule.forRoot({ events: [AccountOpenedEvent] }), Depth1Module],
			providers: [RecordingPublisher, RecordingSubscriber],
		});
		await app.get(EventBus).whenIdle();

		expect(hooks).toEqual(['user global module', 'event sourcing module', 'depth-4 module']);
		expect(delivered.sort()).toEqual(
			[
				`publisher:${globalId.value}`,
				`subscriber:${globalId.value}`,
				`publisher:${deepId.value}`,
				`subscriber:${deepId.value}`,
			].sort(),
		);
	});

	it('registers on first use when the application is compiled but not initialised', async () => {
		@CommandHandler(PingCommand)
		class PingHandler implements ICommandHandler<PingCommand> {
			async execute() {
				return 'pong';
			}
		}

		const app = await compile({
			imports: [EventSourcingModule.forRoot({ events: [AccountOpenedEvent] })],
			providers: [PingHandler, RecordingSubscriber],
		});

		await expect(app.get(CommandBus).execute(new PingCommand())).resolves.toBe('pong');
		await open(app.get(EventStore));
		await app.get(EventBus).whenIdle();
		expect(delivered).toHaveLength(1);
		// The module's own hook registers nothing twice
		await app.init();
		await open(app.get(EventStore));
		await app.get(EventBus).whenIdle();
		expect(delivered).toHaveLength(2);
	});

	it('registers when the first thing used is the event bus', async () => {
		const app = await compile({
			imports: [EventSourcingModule.forRoot({ events: [AccountOpenedEvent] })],
			providers: [RecordingPublisher],
		});
		const envelope = EventEnvelope.create('bootstrap-account-opened', {}, { aggregateId: 'published', version: 1 });

		await app.get(EventBus).publish(envelope);

		expect(delivered).toEqual(['publisher:published']);
	});

	describe('while the providers are instantiated', () => {
		it('rejects an append from a provider factory with EventSourcingNotReadyException, before any I/O', async () => {
			const getStreamVersion = vi.spyOn(InMemoryEventStore.prototype, 'getStreamVersion');
			const seed: Provider = {
				provide: 'SEED',
				inject: [EventStore],
				useFactory: async (eventStore: EventStore) => open(eventStore),
			};

			const error = await failure(
				compile({ imports: [EventSourcingModule.forRoot({ events: [AccountOpenedEvent] })], providers: [seed] }),
			);

			expect(error).toBeInstanceOf(EventSourcingNotReadyException);
			expect(error).toMatchObject({
				code: 'ES_EVENT_SOURCING_NOT_READY',
				operation: 'The EventMap (appendEvents, getEvent, getEvents)',
				pendingProviders: expect.arrayContaining(['SEED']),
			});
			expect(getStreamVersion).not.toHaveBeenCalled();
		});

		it('rejects a command from a provider factory with EventSourcingNotReadyException', async () => {
			const execute: Provider = {
				provide: 'EXECUTE',
				inject: [CommandBus],
				useFactory: async (commandBus: CommandBus) => commandBus.execute(new PingCommand()),
			};

			const error = await failure(compile({ imports: [EventSourcingModule.forRoot({})], providers: [execute] }));

			expect(error).toBeInstanceOf(EventSourcingNotReadyException);
			expect((error as EventSourcingNotReadyException).operation).toBe('CommandBus.execute');
		});

		it('rejects a query or a publication from a provider factory with EventSourcingNotReadyException', async () => {
			const query: Provider = {
				provide: 'QUERY',
				inject: [QueryBus],
				useFactory: async (queryBus: QueryBus) => queryBus.execute(new PingQuery()),
			};
			const publish: Provider = {
				provide: 'PUBLISH',
				inject: [EventBus],
				useFactory: async (eventBus: EventBus) => eventBus.publishAll([]),
			};

			expect(await failure(compile({ imports: [EventSourcingModule.forRoot({})], providers: [query] }))).toMatchObject({
				operation: 'QueryBus.execute',
			});
			expect(
				await failure(compile({ imports: [EventSourcingModule.forRoot({})], providers: [publish] })),
			).toMatchObject({
				operation: 'EventBus.publishAll',
			});
		});
	});
});

// ---- handlers ---------------------------------------------------------------------------------------------------

describe('command and query handlers', () => {
	type Seen = { instance: number; request: unknown };
	class WhoAmICommand extends Command<Seen> {}
	class WhoAmIQuery extends Query<Seen> {}
	class TransientCommand extends Command<number> {}
	class DependentCommand extends Command<Seen> {}
	class DependentQuery extends Query<Seen> {}
	class FactoryCommand extends Command<string> {}
	class ValueQuery extends Query<string> {}

	let instances = 0;

	@Injectable({ scope: Scope.REQUEST })
	@CommandHandler(WhoAmICommand)
	class RequestScopedCommandHandler implements ICommandHandler<WhoAmICommand> {
		readonly instance = ++instances;
		constructor(@Inject(REQUEST) private readonly request: unknown) {}
		async execute() {
			return { instance: this.instance, request: this.request };
		}
	}

	@Injectable({ scope: Scope.REQUEST })
	@QueryHandler(WhoAmIQuery)
	class RequestScopedQueryHandler implements IQueryHandler<WhoAmIQuery> {
		readonly instance = ++instances;
		constructor(@Inject(REQUEST) private readonly request: unknown) {}
		async execute() {
			return { instance: this.instance, request: this.request };
		}
	}

	@Injectable({ scope: Scope.TRANSIENT })
	@CommandHandler(TransientCommand)
	class TransientCommandHandler implements ICommandHandler<TransientCommand> {
		readonly instance = ++instances;
		async execute() {
			return this.instance;
		}
	}

	@Injectable({ scope: Scope.REQUEST })
	class RequestContext {
		readonly instance = ++instances;
		constructor(@Inject(REQUEST) readonly request: unknown) {}
	}

	// A singleton by declaration, but its dependency makes it request-scoped
	@CommandHandler(DependentCommand)
	class DependentCommandHandler implements ICommandHandler<DependentCommand> {
		constructor(private readonly context: RequestContext) {}
		async execute() {
			return { instance: this.context.instance, request: this.context.request };
		}
	}

	@QueryHandler(DependentQuery)
	class DependentQueryHandler implements IQueryHandler<DependentQuery> {
		constructor(private readonly context: RequestContext) {}
		async execute() {
			return { instance: this.context.instance, request: this.context.request };
		}
	}

	@CommandHandler(FactoryCommand)
	class FactoryCommandHandler implements ICommandHandler<FactoryCommand> {
		async execute() {
			return 'from a factory provider';
		}
	}

	@QueryHandler(ValueQuery)
	class ValueQueryHandler implements IQueryHandler<ValueQuery> {
		async execute() {
			return 'from a value provider';
		}
	}

	const handlersApp = () =>
		bootstrap({
			imports: [EventSourcingModule.forRoot({})],
			providers: [
				RequestScopedCommandHandler,
				RequestScopedQueryHandler,
				TransientCommandHandler,
				RequestContext,
				DependentCommandHandler,
				DependentQueryHandler,
				{ provide: 'FACTORY_HANDLER', useFactory: () => new FactoryCommandHandler() },
				{ provide: 'VALUE_HANDLER', useValue: new ValueQueryHandler() },
			],
		});

	it('resolves a request-scoped command handler per call, with REQUEST', async () => {
		const commandBus = (await handlersApp()).get(CommandBus);
		const first = { id: 'request-1' };
		const second = { id: 'request-2' };

		const withoutRequest = [
			await commandBus.execute(new WhoAmICommand()),
			await commandBus.execute(new WhoAmICommand()),
		];
		const withFirst = [
			await commandBus.execute(new WhoAmICommand(), { request: first }),
			await commandBus.execute(new WhoAmICommand(), { request: first }),
		];
		const withSecond = await commandBus.execute(new WhoAmICommand(), { request: second });

		// Without a request: a fresh instance for every call, and no request
		expect(withoutRequest[0].instance).not.toBe(withoutRequest[1].instance);
		expect(withoutRequest.map(({ request }) => request)).toEqual([undefined, undefined]);
		// With a request: one instance per request, which gets the request
		expect(withFirst[0].instance).toBe(withFirst[1].instance);
		expect(withFirst.map(({ request }) => request)).toEqual([first, first]);
		expect(withSecond.instance).not.toBe(withFirst[0].instance);
		expect(withSecond.request).toBe(second);
	});

	it('resolves a request-scoped query handler per call, with REQUEST', async () => {
		const queryBus = (await handlersApp()).get(QueryBus);
		const request = { id: 'request' };

		const first = await queryBus.execute(new WhoAmIQuery(), { request });
		const second = await queryBus.execute(new WhoAmIQuery());
		const third = await queryBus.execute(new WhoAmIQuery());

		expect(first.request).toBe(request);
		expect(second.request).toBeUndefined();
		expect(new Set([first.instance, second.instance, third.instance]).size).toBe(3);
	});

	it('shares the request-scoped instances of one request between commands and queries', async () => {
		const app = await handlersApp();
		const request = { id: 'shared' };

		const fromCommand = await app.get(CommandBus).execute(new DependentCommand(), { request });
		const again = await app.get(CommandBus).execute(new DependentCommand(), { request });
		const fromQuery = await app.get(QueryBus).execute(new DependentQuery(), { request });

		expect(fromCommand.request).toBe(request);
		expect(again.instance).toBe(fromCommand.instance);
		expect(fromQuery).toEqual(fromCommand);
	});

	it('registers one request in every application that executes for it', async () => {
		const [first, second] = [await handlersApp(), await handlersApp()];
		const request = { id: 'two applications' };

		const fromFirst = await first.get(CommandBus).execute(new WhoAmICommand(), { request });
		const fromSecond = await second.get(CommandBus).execute(new WhoAmICommand(), { request });

		expect(fromFirst.request).toBe(request);
		expect(fromSecond.request).toBe(request);
		expect(fromSecond.instance).not.toBe(fromFirst.instance);
	});

	it('resolves a transient handler, and one that depends on a request-scoped provider, per call', async () => {
		const commandBus = (await handlersApp()).get(CommandBus);

		const transient = [
			await commandBus.execute(new TransientCommand()),
			await commandBus.execute(new TransientCommand()),
		];
		const dependent = [
			await commandBus.execute(new DependentCommand()),
			await commandBus.execute(new DependentCommand()),
		];

		expect(transient[0]).not.toBe(transient[1]);
		expect(dependent[0].instance).not.toBe(dependent[1].instance);
	});

	it('discovers handlers provided with useFactory and useValue by the class of their instance', async () => {
		const app = await handlersApp();

		await expect(app.get(CommandBus).execute(new FactoryCommand())).resolves.toBe('from a factory provider');
		await expect(app.get(QueryBus).execute(new ValueQuery())).resolves.toBe('from a value provider');
	});

	it('publishes a command only once its handler is resolved', async () => {
		@Injectable({ scope: Scope.REQUEST })
		@CommandHandler(FailingCommand)
		class FailingCommandHandler implements ICommandHandler<FailingCommand> {
			constructor() {
				throw new Error('cannot resolve');
			}
			async execute() {
				return undefined;
			}
		}
		const app = await bootstrap({ imports: [EventSourcingModule.forRoot({})], providers: [FailingCommandHandler] });
		const commandBus = app.get(CommandBus);
		const published: unknown[] = [];
		commandBus.subscribe((command) => published.push(command));

		await expect(commandBus.execute(new FailingCommand())).rejects.toThrow('cannot resolve');
		expect(published).toEqual([]);
	});
});
