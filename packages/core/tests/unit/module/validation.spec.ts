import { Inject, Injectable, Logger, Module, type ModuleMetadata, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import {
	COMMAND_HANDLER_METADATA,
	CommandBus,
	CommandHandler,
	EVENT_SUBSCRIBER_METADATA,
	Event,
	EventBus,
	type EventEnvelope,
	EventMap,
	EventPublisher,
	EventSerializer,
	type EventSourcingConfigurationIssue,
	EventSourcingConfigurationException,
	EventSourcingModule,
	EventSubscriber,
	type ICommandHandler,
	type IEvent,
	type IEventPayload,
	type IEventPublisher,
	type IEventSerializer,
	type IEventSubscriber,
	type IQueryHandler,
	type ProviderWrapper,
	QUERY_HANDLER_METADATA,
	QueryHandler,
	isEventSourcingError,
} from '@ocoda/event-sourcing';
import { EventSourcingFeature } from '../../../lib/registration/event-sourcing-feature.js';
import { planRegistration } from '../../../lib/registration/plan.js';

// ---- fixtures -----------------------------------------------------------------------------------------------------

@Event('validation-opened')
class OpenedEvent implements IEvent {}

@Event('validation-closed')
class ClosedEvent implements IEvent {}

// Shares the name of OpenedEvent
@Event('validation-opened')
class ImpostorOpenedEvent implements IEvent {}

class UndecoratedEvent implements IEvent {}

@Event('validation-unregistered')
class UnregisteredEvent implements IEvent {}

class OpenCommand {}
class GetQuery {}

@CommandHandler(OpenCommand)
class OpenHandler implements ICommandHandler<OpenCommand> {
	async execute() {
		return 'first';
	}
}

@CommandHandler(OpenCommand)
class OtherOpenHandler implements ICommandHandler<OpenCommand> {
	async execute() {
		return 'second';
	}
}

@QueryHandler(GetQuery)
class GetHandler implements IQueryHandler<GetQuery> {
	async execute() {
		return 'first';
	}
}

@QueryHandler(GetQuery)
class OtherGetHandler implements IQueryHandler<GetQuery> {
	async execute() {
		return 'second';
	}
}

abstract class TestSerializer implements IEventSerializer {
	serialize(): IEventPayload<IEvent> {
		return {} as IEventPayload<IEvent>;
	}
	deserialize(): IEvent {
		return {};
	}
}

@EventSerializer(OpenedEvent)
class OpenedSerializer extends TestSerializer {}

@EventSerializer(OpenedEvent)
class OtherOpenedSerializer extends TestSerializer {}

@EventSerializer(UnregisteredEvent)
class UnregisteredEventSerializer extends TestSerializer {}

class UndecoratedSerializer extends TestSerializer {}

const received: string[] = [];

@EventSubscriber(OpenedEvent)
class OpenedSubscriber implements IEventSubscriber {
	handle({ event }: EventEnvelope) {
		received.push(event);
	}
}

@EventSubscriber(UnregisteredEvent)
class UnregisteredEventSubscriber implements IEventSubscriber {
	handle() {}
}

@EventSubscriber()
class EmptySubscriber implements IEventSubscriber {
	handle() {}
}

@EventPublisher()
class RecordingPublisher implements IEventPublisher {
	publish() {}
}

@Injectable({ scope: Scope.REQUEST })
@EventSubscriber(OpenedEvent)
class RequestScopedSubscriber implements IEventSubscriber {
	handle() {}
}

// Request-scoped through its factory provider, which uses the class as its token
@EventSubscriber(OpenedEvent)
class FactorySubscriber implements IEventSubscriber {
	handle() {}
}

@Injectable({ scope: Scope.TRANSIENT })
@EventPublisher()
class TransientPublisher implements IEventPublisher {
	publish() {}
}

@Injectable({ scope: Scope.REQUEST })
class RequestContext {
	constructor(@Inject(REQUEST) readonly request: unknown) {}
}

@EventSerializer(OpenedEvent)
class RequestDependentSerializer extends TestSerializer {
	constructor(readonly context: RequestContext) {
		super();
	}
}

// ---- helpers ------------------------------------------------------------------------------------------------------

const apps: TestingModule[] = [];

const init = async (metadata: ModuleMetadata): Promise<TestingModule> => {
	const app = await Test.createTestingModule(metadata).compile();
	apps.push(app);
	await app.init();
	return app;
};

/**
 * The issues the bootstrap fails with.
 */
const issuesOf = async (metadata: ModuleMetadata): Promise<EventSourcingConfigurationIssue[]> => {
	const error = await init(metadata).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(EventSourcingConfigurationException);
	expect(isEventSourcingError(error, 'ES_EVENT_SOURCING_CONFIGURATION')).toBe(true);
	return [...(error as EventSourcingConfigurationException).issues];
};

const root = (events: unknown[] = [OpenedEvent, ClosedEvent]) =>
	EventSourcingModule.forRoot({ events: events as (new () => IEvent)[] });

beforeEach(() => {
	received.length = 0;
	vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
	vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(async () => {
	for (const app of apps.splice(0)) {
		await app.close().catch(() => undefined);
	}
});

// ---- bootstrap ----------------------------------------------------------------------------------------------------

describe('bootstrap validation', () => {
	it.each<[string, ModuleMetadata, EventSourcingConfigurationIssue['kind'], RegExp]>([
		[
			'an event name shared by two classes',
			{ imports: [root([OpenedEvent, ImpostorOpenedEvent])] },
			'duplicate-event-name',
			/OpenedEvent and ImpostorOpenedEvent share the event name "validation-opened"/,
		],
		[
			'two handlers for one command',
			{ imports: [root()], providers: [OpenHandler, OtherOpenHandler] },
			'duplicate-command-handler',
			/OpenHandler and OtherOpenHandler both handle the command OpenCommand/,
		],
		[
			'two handlers for one query',
			{ imports: [root()], providers: [GetHandler, OtherGetHandler] },
			'duplicate-query-handler',
			/GetHandler and OtherGetHandler both handle the query GetQuery/,
		],
		[
			'two serializers for one event',
			{ imports: [root()], providers: [OpenedSerializer, OtherOpenedSerializer] },
			'duplicate-event-serializer',
			/OpenedSerializer and OtherOpenedSerializer both serialize the event OpenedEvent/,
		],
		[
			'a serializer for an unregistered event',
			{ imports: [root()], providers: [UnregisteredEventSerializer] },
			'unregistered-event',
			/serializer UnregisteredEventSerializer is for the event UnregisteredEvent, which is not registered/,
		],
		[
			'a subscriber for an unregistered event',
			{ imports: [root()], providers: [UnregisteredEventSubscriber] },
			'unregistered-event',
			/subscriber UnregisteredEventSubscriber is for the event UnregisteredEvent, which is not registered/,
		],
		[
			'an event without @Event() metadata',
			{ imports: [root([UndecoratedEvent])] },
			'missing-metadata',
			/event UndecoratedEvent in EventSourcingModule.forRoot\(\) has no @Event\(\) metadata/,
		],
		[
			'a serializer of forFeature() without @EventSerializer() metadata',
			{ imports: [root(), EventSourcingModule.forFeature({ serializers: [UndecoratedSerializer] })] },
			'missing-metadata',
			/serializer UndecoratedSerializer in EventSourcingModule.forFeature\(\) has no @EventSerializer\(\) metadata/,
		],
		[
			'a subscriber that names no events',
			{ imports: [root()], providers: [EmptySubscriber] },
			'missing-metadata',
			/subscriber EmptySubscriber names no events/,
		],
		[
			'a request-scoped subscriber',
			{ imports: [root()], providers: [RequestScopedSubscriber] },
			'non-static-provider',
			/subscriber RequestScopedSubscriber is request-scoped/,
		],
		[
			'a request-scoped subscriber provided with useFactory',
			{
				imports: [root()],
				providers: [{ provide: FactorySubscriber, useFactory: () => new FactorySubscriber(), scope: Scope.REQUEST }],
			},
			'non-static-provider',
			/subscriber FactorySubscriber is request-scoped/,
		],
		[
			'a transient publisher',
			{ imports: [root()], providers: [TransientPublisher] },
			'non-static-provider',
			/publisher TransientPublisher is transient/,
		],
		[
			'a serializer that depends on a request-scoped provider',
			{ imports: [root()], providers: [RequestContext, RequestDependentSerializer] },
			'non-static-provider',
			/serializer RequestDependentSerializer depends on a request-scoped provider/,
		],
		[
			'an entry of events that is not a class',
			{ imports: [root([OpenedEvent, 'validation-closed'])] },
			'invalid-options',
			/events of EventSourcingModule.forRoot\(\) contain "validation-closed", which is not an event class/,
		],
	])('fails on %s', async (_, metadata, kind, message) => {
		const issues = await issuesOf(metadata);

		expect(issues).toEqual([{ kind, message: expect.stringMatching(message) }]);
	});

	it('reports every issue at once, in one exception', async () => {
		const issues = await issuesOf({
			imports: [root([OpenedEvent, ImpostorOpenedEvent, UndecoratedEvent])],
			providers: [OpenHandler, OtherOpenHandler, UnregisteredEventSubscriber, TransientPublisher],
		});

		expect(issues.map(({ kind }) => kind).sort()).toEqual(
			[
				'duplicate-command-handler',
				'duplicate-event-name',
				'missing-metadata',
				'non-static-provider',
				'unregistered-event',
			].sort(),
		);
	});

	it('names the issues in the message of the exception', async () => {
		const error = await init({ imports: [root()], providers: [OpenHandler, OtherOpenHandler] }).catch(
			(error: unknown) => error as Error,
		);

		expect((error as Error).message).toBe(
			'Invalid EventSourcingModule configuration (1 issue)\n- [duplicate-command-handler] OpenHandler and OtherOpenHandler both handle the command OpenCommand: keep one handler per command.',
		);
	});

	it('fails on a store config without a driver class', async () => {
		const error = await Test.createTestingModule({
			imports: [EventSourcingModule.forRoot({ eventStore: { driver: 'postgres' as never } })],
		})
			.compile()
			.catch((error: unknown) => error);

		expect(error).toBeInstanceOf(EventSourcingConfigurationException);
		expect((error as EventSourcingConfigurationException).issues).toEqual([
			{ kind: 'invalid-options', message: expect.stringContaining('eventStore.driver must be the class of the store') },
		]);

		const snapshotError = await Test.createTestingModule({
			imports: [EventSourcingModule.forRoot({ snapshotStore: { driver: undefined as never } })],
		})
			.compile()
			.catch((error: unknown) => error);
		expect((snapshotError as EventSourcingConfigurationException).issues[0]?.message).toContain(
			'snapshotStore.driver must be the class of the store',
		);
	});

	it('registers nothing when the configuration is invalid', async () => {
		const register = vi.spyOn(EventMap.prototype, 'registerSerializers');

		await issuesOf({ imports: [root()], providers: [OpenHandler, OtherOpenHandler] });

		expect(register).not.toHaveBeenCalled();
	});

	describe('repeated registrations of one class', () => {
		@Module({
			imports: [EventSourcingModule.forFeature({ events: [OpenedEvent] })],
			providers: [OpenedSubscriber, OpenHandler],
		})
		class FirstModule {}

		@Module({
			imports: [EventSourcingModule.forFeature({ events: [OpenedEvent, OpenedEvent] })],
			providers: [OpenedSubscriber, OpenHandler, OpenedSerializer],
		})
		class SecondModule {}

		it('are deduplicated', async () => {
			const app = await init({
				imports: [root([OpenedEvent]), FirstModule, SecondModule],
				providers: [OpenedSerializer],
			});

			await expect(app.get(CommandBus).execute(new OpenCommand())).resolves.toBe('first');
			// One subscriber, although two modules provide it
			const eventBus = app.get(EventBus);
			await eventBus.publish({ event: 'validation-opened', metadata: { aggregateId: 'a' } } as EventEnvelope);
			await eventBus.whenIdle();
			expect(received).toEqual(['validation-opened']);
		});
	});
});

// ---- plan ---------------------------------------------------------------------------------------------------------

describe(planRegistration, () => {
	const wrapper = (instance: object, extra: Partial<ProviderWrapper> = {}) =>
		({ instance, metatype: instance.constructor, ...extra }) as unknown as ProviderWrapper;

	it('reports events that are not an array', () => {
		const plan = planRegistration([wrapper(new EventSourcingFeature('nope' as never))], 'also nope');

		expect(plan.issues).toEqual([
			{ kind: 'invalid-options', message: expect.stringContaining('EventSourcingModule.forRoot() must be an array') },
			{
				kind: 'invalid-options',
				message: expect.stringContaining('EventSourcingModule.forFeature() must be an array'),
			},
		]);
	});

	it('reports serializers of forFeature() that are not classes', () => {
		const plan = planRegistration([wrapper(new EventSourcingFeature([], [42 as never]))], []);

		expect(plan.issues).toEqual([
			{
				kind: 'invalid-options',
				message: 'The serializers of EventSourcingModule.forFeature() contain 42, which is not a class.',
			},
		]);
	});

	it('reports handlers and serializers whose decorator names no message class', () => {
		class NoCommandHandler {}
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, { command: undefined }, NoCommandHandler);
		class NoQueryHandler {}
		Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query: undefined }, NoQueryHandler);
		@EventSerializer(undefined as never)
		class NoEventSerializer extends TestSerializer {}

		const plan = planRegistration(
			[wrapper(new NoCommandHandler()), wrapper(new NoQueryHandler()), wrapper(new NoEventSerializer())],
			[],
		);

		expect(plan.issues.map(({ kind }) => kind)).toEqual(['missing-metadata', 'missing-metadata', 'missing-metadata']);
		expect(plan.issues.map(({ message }) => message)).toEqual([
			expect.stringContaining('command handler NoCommandHandler names no command class'),
			expect.stringContaining('query handler NoQueryHandler names no query class'),
			expect.stringContaining('event serializer NoEventSerializer names no event class'),
		]);
	});

	it('reports a subscriber that names something other than an event class', () => {
		class OddSubscriber {}
		Reflect.defineMetadata(EVENT_SUBSCRIBER_METADATA, { events: ['validation-opened'] }, OddSubscriber);

		const plan = planRegistration([wrapper(new OddSubscriber())], [OpenedEvent]);

		expect(plan.issues).toEqual([
			{
				kind: 'missing-metadata',
				message: expect.stringContaining('names "validation-opened", which is not an event class'),
			},
		]);
		expect(plan.subscribers).toEqual([]);
	});

	it('plans the registration of a valid configuration', () => {
		const handler = wrapper(new OpenHandler());
		const query = wrapper(new GetHandler());
		const serializer = wrapper(new OpenedSerializer());
		const subscriber = wrapper(new OpenedSubscriber());
		const publisher = wrapper(new RecordingPublisher());

		const plan = planRegistration(
			[
				wrapper(new EventSourcingFeature([ClosedEvent])),
				handler,
				query,
				serializer,
				subscriber,
				publisher,
				// Not discoverable: no instance and no class
				{ instance: null, metatype: () => undefined, inject: [] } as unknown as ProviderWrapper,
				wrapper({ plain: true }),
			],
			[OpenedEvent],
		);

		expect(plan).toEqual({
			events: [OpenedEvent, ClosedEvent],
			serializers: [serializer],
			commands: [handler],
			queries: [query],
			publishers: [publisher],
			subscribers: [subscriber],
			issues: [],
		});
	});

	it('reads the metadata of a class provider that has no instance yet from its class', () => {
		const handler = { instance: undefined, metatype: OpenHandler } as unknown as ProviderWrapper;

		expect(planRegistration([handler], []).commands).toEqual([handler]);
	});

	it('plans request-scoped handlers too: the buses resolve them per call', () => {
		const scoped = wrapper(new OpenHandler(), {
			isDependencyTreeStatic: () => false,
			scope: Scope.REQUEST,
		} as Partial<ProviderWrapper>);

		const plan = planRegistration([scoped], []);

		expect(plan.commands).toEqual([scoped]);
		expect(plan.issues).toEqual([]);
	});
});
