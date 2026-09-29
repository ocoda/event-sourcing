import type { DiscoveryService } from '@nestjs/core';
import {
	COMMAND_HANDLER_METADATA,
	EVENT_PUBLISHER_METADATA,
	EVENT_SERIALIZER_METADATA,
	EVENT_SUBSCRIBER_METADATA,
	Event,
	type EventSourcingModuleOptions,
	type IEvent,
	type ProviderWrapper,
	QUERY_HANDLER_METADATA,
} from '@ocoda/event-sourcing';
import { EventRegistry } from '@ocoda/event-sourcing/registries';
import { ExplorerService } from '@ocoda/event-sourcing/services';
import type { Mocked } from 'vitest';

@Event('event-a')
class EventA implements IEvent {}

@Event('event-b')
class EventB implements IEvent {}

describe('ExplorerService', () => {
	let explorerService: ExplorerService;
	let discoveryServiceMock: Mocked<Pick<DiscoveryService, 'getProviders'>>;
	let optionsMock: Mocked<EventSourcingModuleOptions>;

	const createWrapper = (instance: any, metadataKey?: string): ProviderWrapper => {
		const wrapper = { instance } as ProviderWrapper;
		if (metadataKey) {
			Reflect.defineMetadata(metadataKey, true, instance.constructor);
		}
		return wrapper;
	};

	beforeEach(() => {
		optionsMock = { events: [EventA] };
		discoveryServiceMock = {
			getProviders: vi.fn().mockReturnValue([]),
		};
		explorerService = new ExplorerService(optionsMock, discoveryServiceMock as unknown as DiscoveryService);
		vi.spyOn(EventRegistry, 'getEvents').mockReturnValue([EventB]);
	});

	it('should return correct events from options and registry', () => {
		const result = explorerService.explore();
		expect(result.events).toEqual([EventA, EventB]);
	});

	it('should filter providers by metadata keys', () => {
		class QueryHandler {}
		class CommandHandler {}
		class EventPublisher {}
		class EventSubscriber {}
		class EventSerializer {}

		const queryWrapper = createWrapper(new QueryHandler(), QUERY_HANDLER_METADATA);
		const commandWrapper = createWrapper(new CommandHandler(), COMMAND_HANDLER_METADATA);
		const publisherWrapper = createWrapper(new EventPublisher(), EVENT_PUBLISHER_METADATA);
		const subscriberWrapper = createWrapper(new EventSubscriber(), EVENT_SUBSCRIBER_METADATA);
		const serializerWrapper = createWrapper(new EventSerializer(), EVENT_SERIALIZER_METADATA);

		discoveryServiceMock.getProviders.mockReturnValue([
			queryWrapper,
			commandWrapper,
			publisherWrapper,
			subscriberWrapper,
			serializerWrapper,
		] as any);

		const result = explorerService.explore();

		expect(result.queries).toEqual([queryWrapper]);
		expect(result.commands).toEqual([commandWrapper]);
		expect(result.eventPublishers).toEqual([publisherWrapper]);
		expect(result.eventSubscribers).toEqual([subscriberWrapper]);
		expect(result.eventSerializers).toEqual([serializerWrapper]);
	});

	it('should skip providers without metadata', () => {
		class NoMeta {}
		discoveryServiceMock.getProviders.mockReturnValue([createWrapper(new NoMeta())] as any);

		const result = explorerService.explore();

		expect(result.queries).toEqual([]);
		expect(result.commands).toEqual([]);
		expect(result.eventPublishers).toEqual([]);
		expect(result.eventSubscribers).toEqual([]);
		expect(result.eventSerializers).toEqual([]);
	});

	it('should skip providers with undefined instance', () => {
		discoveryServiceMock.getProviders.mockReturnValue([{ instance: undefined } as ProviderWrapper] as any);

		const result = explorerService.explore();

		expect(result.queries).toEqual([]);
		expect(result.commands).toEqual([]);
		expect(result.eventPublishers).toEqual([]);
		expect(result.eventSubscribers).toEqual([]);
		expect(result.eventSerializers).toEqual([]);
	});
});
