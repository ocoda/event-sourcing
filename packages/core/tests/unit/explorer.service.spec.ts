import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
	COMMAND_HANDLER_METADATA,
	Event,
	EVENT_PUBLISHER_METADATA,
	EVENT_SERIALIZER_METADATA,
	EVENT_SUBSCRIBER_METADATA,
	type EventSourcingModuleOptions,
	type IEvent,
	QUERY_HANDLER_METADATA,
} from '@ocoda/event-sourcing';
import { EventRegistry } from '@ocoda/event-sourcing/registries';
import { ExplorerService } from '@ocoda/event-sourcing/services';

@Event('event-a')
class EventA implements IEvent {}

@Event('event-b')
class EventB implements IEvent {}

describe('ExplorerService', () => {
	let explorerService: ExplorerService;
	let modulesContainerMock: any;
	let optionsMock: jest.Mocked<EventSourcingModuleOptions>;

	const createInstanceWrapper = (instance: any, metadataKey?: string) => {
		const wrapper: InstanceWrapper = { instance } as any;
		if (metadataKey) {
			Reflect.defineMetadata(metadataKey, true, instance.constructor);
		}
		return wrapper;
	};

	const createModule = (providers: InstanceWrapper[]) => ({
		providers: new Map(providers.map((p, i) => [i, p])),
	});

	beforeEach(() => {
		optionsMock = { events: [EventA] };
		modulesContainerMock = {
			values: jest.fn(),
		};
		explorerService = new ExplorerService(optionsMock, modulesContainerMock);
		jest.spyOn(EventRegistry, 'getEvents').mockReturnValue([EventB]);
	});

	it('should return correct events from options and registry', () => {
		modulesContainerMock.values.mockReturnValue([]);
		const result = explorerService.explore();
		expect(result.events).toEqual([EventA, EventB]);
	});

	it('should filter providers by metadata keys', () => {
		class QueryHandler {}
		class CommandHandler {}
		class EventPublisher {}
		class EventSubscriber {}
		class EventSerializer {}

		const queryWrapper = createInstanceWrapper(new QueryHandler(), QUERY_HANDLER_METADATA);
		const commandWrapper = createInstanceWrapper(new CommandHandler(), COMMAND_HANDLER_METADATA);
		const publisherWrapper = createInstanceWrapper(new EventPublisher(), EVENT_PUBLISHER_METADATA);
		const subscriberWrapper = createInstanceWrapper(new EventSubscriber(), EVENT_SUBSCRIBER_METADATA);
		const serializerWrapper = createInstanceWrapper(new EventSerializer(), EVENT_SERIALIZER_METADATA);

		const moduleMock = createModule([
			queryWrapper,
			commandWrapper,
			publisherWrapper,
			subscriberWrapper,
			serializerWrapper,
		]);

		modulesContainerMock.values.mockReturnValue([moduleMock]);

		const result = explorerService.explore();

		expect(result.queries).toEqual([queryWrapper]);
		expect(result.commands).toEqual([commandWrapper]);
		expect(result.eventPublishers).toEqual([publisherWrapper]);
		expect(result.eventSubscribers).toEqual([subscriberWrapper]);
		expect(result.eventSerializers).toEqual([serializerWrapper]);
	});

	it('should skip providers without metadata', () => {
		class NoMeta {}
		const wrapper = createInstanceWrapper(new NoMeta());
		const moduleMock = createModule([wrapper]);
		modulesContainerMock.values.mockReturnValue([moduleMock]);

		const result = explorerService.explore();

		expect(result.queries).toEqual([]);
		expect(result.commands).toEqual([]);
		expect(result.eventPublishers).toEqual([]);
		expect(result.eventSubscribers).toEqual([]);
		expect(result.eventSerializers).toEqual([]);
	});

	it('should skip providers with undefined instance', () => {
		const wrapper = { instance: undefined } as InstanceWrapper;
		const moduleMock = createModule([wrapper]);
		modulesContainerMock.values.mockReturnValue([moduleMock]);

		const result = explorerService.explore();

		expect(result.queries).toEqual([]);
		expect(result.commands).toEqual([]);
		expect(result.eventPublishers).toEqual([]);
		expect(result.eventSubscribers).toEqual([]);
		expect(result.eventSerializers).toEqual([]);
	});
});
