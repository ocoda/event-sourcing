import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { CommandBus } from './command-bus';
import {
	COMMAND_HANDLER_METADATA,
	EVENT_HANDLER_METADATA,
	EVENT_SERIALIZER_METADATA,
	InjectEventSourcingOptions,
	QUERY_HANDLER_METADATA,
} from './decorators';
import { EventBus } from './event-bus';
import { EventMap } from './event-map';
import { EventStore } from './event-store';
import {
	MissingCommandHandlerMetadataException,
	MissingCommandMetadataException,
	MissingEventHandlerMetadataException,
	MissingEventMetadataException,
	MissingQueryHandlerMetadataException,
	MissingQueryMetadataException,
} from './exceptions';
import {
	DefaultEventSerializer,
	getCommandHandlerMetadata,
	getCommandMetadata,
	getEventMetadata,
	getEventSerializerMetadata,
	getQueryHandlerMetadata,
	getQueryMetadata,
} from './helpers';
import { getEventHandlerMetadata } from './helpers/metadata/get-event-handler-metadata';
import { EventSourcingModuleOptions } from './interfaces';
import { QueryBus } from './query-bus';

enum HandlerType {
	COMMAND,
	QUERY,
	EVENT,
	SERIALIZATION,
}

@Injectable()
export class HandlersLoader implements OnApplicationBootstrap {
	private handlers: Map<HandlerType, InstanceWrapper<any>[]> = new Map(
		Object.values(HandlerType).map((key) => [HandlerType[key], []]),
	);

	constructor(
		@InjectEventSourcingOptions()
		private readonly options: EventSourcingModuleOptions,
		private readonly discoveryService: DiscoveryService,
		private readonly commandBus: CommandBus,
		private readonly queryBus: QueryBus,
		private readonly eventBus: EventBus,
		private readonly eventStore: EventStore,
		private readonly eventMap: EventMap,
	) {}

	onApplicationBootstrap() {
		this.loadHandlers();

		this.registerCommandHandlers();
		this.registerQueryHandlers();
		this.registerEventSerializers();
		this.registerEventHandlers();
		this.registerEventStore();
	}

	private loadHandlers() {
		const providers = this.discoveryService.getProviders();

		providers.forEach((wrapper) => {
			if (wrapper.metatype) {
				if (Reflect.hasMetadata(COMMAND_HANDLER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.COMMAND).push(wrapper);
				}
				if (Reflect.hasMetadata(QUERY_HANDLER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.QUERY).push(wrapper);
				}
				if (Reflect.hasMetadata(EVENT_HANDLER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.EVENT).push(wrapper);
				}
				if (Reflect.hasMetadata(EVENT_SERIALIZER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.SERIALIZATION).push(wrapper);
				}
			}
		});
	}

	private registerCommandHandlers() {
		this.handlers.get(HandlerType.COMMAND)?.forEach(({ metatype, instance }) => {
			const { command } = getCommandHandlerMetadata(metatype);

			if (!command) {
				throw new MissingCommandHandlerMetadataException(metatype);
			}

			const { id } = getCommandMetadata(command);

			if (!id) {
				throw new MissingCommandMetadataException(command);
			}

			this.commandBus.bind(instance, id);
		});
	}

	private registerQueryHandlers() {
		this.handlers.get(HandlerType.QUERY)?.forEach(({ metatype, instance }) => {
			const { query } = getQueryHandlerMetadata(metatype);

			if (!query) {
				throw new MissingQueryHandlerMetadataException(metatype);
			}

			const { id } = getQueryMetadata(query);

			if (!id) {
				throw new MissingQueryMetadataException(query);
			}

			this.queryBus.bind(instance, id);
		});
	}

	private registerEventSerializers() {
		this.options?.events.forEach((event) => {
			const handler = this.handlers.get(HandlerType.SERIALIZATION)?.find(({ metatype }) => {
				const { event: registeredEvent } = getEventSerializerMetadata(metatype);
				return registeredEvent === event;
			});

			const serializer =
				handler?.instance || (!this.options.disableDefaultSerializer && DefaultEventSerializer.for(event));

			return this.eventMap.register(event, serializer);
		});
	}

	private registerEventHandlers() {
		this.handlers.get(HandlerType.EVENT)?.forEach(({ metatype, instance }) => {
			const { events } = getEventHandlerMetadata(metatype);

			if (!events) {
				throw new MissingEventHandlerMetadataException(metatype);
			}

			events.forEach((event) => {
				const { name } = getEventMetadata(event);

				if (!name) {
					throw new MissingEventMetadataException(event);
				}

				this.eventBus.bind(instance, name);
			});
		});
	}

	private registerEventStore() {
		this.eventStore.publish = this.eventBus.publish;
	}
}
