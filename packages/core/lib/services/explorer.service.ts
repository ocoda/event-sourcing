import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import {
	COMMAND_HANDLER_METADATA,
	EVENT_PUBLISHER_METADATA,
	EVENT_SERIALIZER_METADATA,
	EVENT_SUBSCRIBER_METADATA,
	InjectEventSourcingOptions,
	QUERY_HANDLER_METADATA,
} from '../decorators/index.js';
import type {
	EventSourcingModuleOptions,
	ICommandHandler,
	IEvent,
	IEventPublisher,
	IEventSerializer,
	IEventSubscriber,
	IQueryHandler,
	ProviderWrapper,
} from '../interfaces/index.js';
import { EventRegistry } from '../registries/index.js';

export type ProvidersIntrospectionResult = {
	/**
	 * For future saga support, currently unused.
	 * @ignore
	 */
	sagas?: ProviderWrapper[];
	events?: Type<IEvent>[];
	queries?: ProviderWrapper<IQueryHandler>[];
	commands?: ProviderWrapper<ICommandHandler>[];
	eventPublishers?: ProviderWrapper<IEventPublisher>[];
	eventSubscribers?: ProviderWrapper<IEventSubscriber>[];
	eventSerializers?: ProviderWrapper<IEventSerializer>[];
};

@Injectable()
export class ExplorerService {
	constructor(
		@InjectEventSourcingOptions()
		private readonly options: EventSourcingModuleOptions,
		private readonly discoveryService: DiscoveryService,
	) {}

	get events(): Type<IEvent>[] {
		return [...(this.options.events ?? []), ...EventRegistry.getEvents()];
	}

	explore(): ProvidersIntrospectionResult {
		const providers = this.discoveryService.getProviders();

		return {
			sagas: [],
			events: this.events,
			queries: this.filterByMetadataKey<IQueryHandler>(providers, QUERY_HANDLER_METADATA),
			commands: this.filterByMetadataKey<ICommandHandler>(providers, COMMAND_HANDLER_METADATA),
			eventPublishers: this.filterByMetadataKey<IEventPublisher>(providers, EVENT_PUBLISHER_METADATA),
			eventSubscribers: this.filterByMetadataKey<IEventSubscriber>(providers, EVENT_SUBSCRIBER_METADATA),
			eventSerializers: this.filterByMetadataKey<IEventSerializer>(providers, EVENT_SERIALIZER_METADATA),
		};
	}

	private filterByMetadataKey<T extends object>(
		providers: ProviderWrapper[],
		metadataKey: string,
	): ProviderWrapper<T>[] {
		return providers.filter((wrapper) => {
			const instance = wrapper.instance;
			if (!instance || !instance.constructor) {
				return false;
			}
			return !!Reflect.getMetadata(metadataKey, instance.constructor);
		}) as ProviderWrapper<T>[];
	}
}
