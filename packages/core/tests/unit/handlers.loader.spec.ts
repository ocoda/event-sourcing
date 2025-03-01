import { DiscoveryService } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { Test, type TestingModule, type TestingModuleBuilder } from '@nestjs/testing';
import {
	COMMAND_HANDLER_METADATA,
	COMMAND_METADATA,
	CommandBus,
	type CommandHandler,
	EVENT_METADATA,
	EVENT_PUBLISHER_METADATA,
	EVENT_SERIALIZER_METADATA,
	EVENT_SOURCING_OPTIONS,
	EVENT_SUBSCRIBER_METADATA,
	EventMap,
	type EventPublisher,
	type EventSerializer,
	type EventSourcingModuleOptions,
	EventStore,
	type EventSubscriber,
	QUERY_HANDLER_METADATA,
	QUERY_METADATA,
	QueryBus,
	type QueryHandler,
} from '@ocoda/event-sourcing';
import { EventBus } from '@ocoda/event-sourcing/event-bus';
import {
	MissingCommandHandlerMetadataException,
	MissingCommandMetadataException,
	MissingEventSubscriberMetadataException,
	MissingQueryHandlerMetadataException,
	MissingQueryMetadataException,
} from '@ocoda/event-sourcing/exceptions';
import { HandlersLoader } from '@ocoda/event-sourcing/handlers.loader';

describe('HandlersLoader', () => {
	let moduleBuilder: TestingModuleBuilder;
	let module: TestingModule;
	let handlersLoader: HandlersLoader;
	let discoveryService: DiscoveryService;
	let commandBus: CommandBus;
	let queryBus: QueryBus;
	let eventBus: EventBus;
	let eventStore: EventStore;
	let eventMap: EventMap;
	let moduleOptions: EventSourcingModuleOptions;

	beforeAll(async () => {
		moduleBuilder = Test.createTestingModule({
			providers: [
				{
					provide: EVENT_SOURCING_OPTIONS,
					useValue: {},
				},
				{
					provide: DiscoveryService,
					useValue: {
						getProviders: jest.fn().mockReturnValue([]),
					},
				},
				{
					provide: CommandBus,
					useValue: {
						bind: jest.fn(),
					},
				},
				{
					provide: QueryBus,
					useValue: {
						bind: jest.fn(),
					},
				},
				{
					provide: EventBus,
					useValue: {
						addPublisher: jest.fn(),
						bind: jest.fn(),
						publish: jest.fn(),
					},
				},
				{
					provide: EventStore,
					useValue: {
						publish: jest.fn(),
					},
				},
				{
					provide: EventMap,
					useValue: {
						register: jest.fn(),
					},
				},
				HandlersLoader,
			],
		});
	});

	beforeEach(async () => {
		module = await moduleBuilder.compile();

		handlersLoader = module.get<HandlersLoader>(HandlersLoader);
		discoveryService = module.get<DiscoveryService>(DiscoveryService);
		commandBus = module.get<CommandBus>(CommandBus);
		queryBus = module.get<QueryBus>(QueryBus);
		eventBus = module.get<EventBus>(EventBus);
		eventStore = module.get<EventStore>(EventStore);
		eventMap = module.get<EventMap>(EventMap);
		moduleOptions = module.get(EVENT_SOURCING_OPTIONS);
	});

	afterEach(async () => await module.close());

	it('should throw MissingQueryHandlerMetadataException if query handler metadata is missing', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query: null }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof QueryHandler>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		expect(() => handlersLoader.onApplicationBootstrap()).toThrow(MissingQueryHandlerMetadataException);
	});

	it('should throw MissingCommandHandlerMetadataException if command handler metadata is missing', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, { command: null }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof CommandHandler>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		expect(() => handlersLoader.onApplicationBootstrap()).toThrow(MissingCommandHandlerMetadataException);
	});

	it('should throw MissingEventSubscriberMetadataException if event subscriber metadata is missing', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		Reflect.defineMetadata(EVENT_SUBSCRIBER_METADATA, { events: null }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof EventSubscriber>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		expect(() => handlersLoader.onApplicationBootstrap()).toThrow(MissingEventSubscriberMetadataException);
	});

	it('should throw MissingCommandMetadataException if command metadata is missing', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		const command = jest.fn();
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, { command }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof CommandHandler>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		expect(() => handlersLoader.onApplicationBootstrap()).toThrow(MissingCommandMetadataException);
	});

	it('should throw MissingQueryMetadataException if query metadata is missing', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		const query = jest.fn();
		Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof QueryHandler>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		expect(() => handlersLoader.onApplicationBootstrap()).toThrow(MissingQueryMetadataException);
	});

	it('should register command handlers correctly', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		const command = jest.fn();
		Reflect.defineMetadata(COMMAND_METADATA, { id: 'test-command' }, command);
		Reflect.defineMetadata(COMMAND_HANDLER_METADATA, { command }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof CommandHandler>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		handlersLoader.onApplicationBootstrap();

		expect(commandBus.bind).toHaveBeenCalledWith(instance, 'test-command');
	});

	it('should register query handlers correctly', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		const query = jest.fn();
		Reflect.defineMetadata(QUERY_METADATA, { id: 'test-query' }, query);
		Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof QueryHandler>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		handlersLoader.onApplicationBootstrap();

		expect(queryBus.bind).toHaveBeenCalledWith(instance, 'test-query');
	});

	it('should register event subscribers correctly', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		const event = jest.fn();
		Reflect.defineMetadata(EVENT_METADATA, { id: 'test-event', name: 'test-event' }, event);
		Reflect.defineMetadata(EVENT_SUBSCRIBER_METADATA, { events: [event] }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof EventSubscriber>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		handlersLoader.onApplicationBootstrap();

		expect(eventBus.bind).toHaveBeenCalledWith(instance, 'test-event');
	});

	it('should register event publishers correctly', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		Reflect.defineMetadata(EVENT_PUBLISHER_METADATA, { id: 'test-publisher' }, metatype);

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof EventPublisher>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		handlersLoader.onApplicationBootstrap();

		expect(eventBus.addPublisher).toHaveBeenCalledWith(instance);
	});

	it('should register event serializers correctly', () => {
		const metatype = jest.fn();
		const instance = jest.fn();
		const event = jest.fn();
		Reflect.defineMetadata(EVENT_METADATA, { id: 'test-event', name: 'test-event' }, event);
		Reflect.defineMetadata(EVENT_SERIALIZER_METADATA, { event }, metatype);
		moduleOptions.events = [event];

		const wrapper = { metatype, instance } as unknown as InstanceWrapper<typeof EventSerializer>;
		jest.spyOn(discoveryService, 'getProviders').mockReturnValue([wrapper]);

		handlersLoader.onApplicationBootstrap();

		expect(eventMap.register).toHaveBeenCalledWith(event, instance);
	});

	it('should register the event store correctly', () => {
		handlersLoader.onApplicationBootstrap();

		expect(eventStore.publish).toBe(eventBus.publish);
	});
});
