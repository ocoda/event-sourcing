import { Injectable, OnApplicationBootstrap, Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { CommandBus } from './command-bus';
import {
	COMMAND_HANDLER_METADATA,
	EVENT_HANDLER_METADATA,
	EVENT_PUBLISHER_METADATA,
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
import {
	EventSourcingModuleOptions,
	ICommand,
	ICommandHandler,
	IEventHandler,
	IEventPublisher,
	IEventSerializer,
	IQueryHandler,
} from './interfaces';
import { QueryBus } from './query-bus';

enum HandlerType {
	COMMAND = 0,
	QUERY = 1,
	EVENT = 2,
	SERIALIZATION = 3,
	PUBLISHING = 4,
}

@Injectable()
export class HandlersLoader implements OnApplicationBootstrap {
	private handlers: Map<
		HandlerType,
		InstanceWrapper<ICommandHandler | IQueryHandler | IEventSerializer | IEventHandler | IEventPublisher | EventStore>[]
	> = new Map(Object.values(HandlerType).map((key) => [HandlerType[key], []]));

	constructor(
		@InjectEventSourcingOptions() private readonly options: EventSourcingModuleOptions,
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
		this.registerEventPublishers();
		this.registerEventStore();
	}

	private loadHandlers() {
		const providers = this.discoveryService.getProviders();

		for (const wrapper of providers) {
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
				if (Reflect.hasMetadata(EVENT_PUBLISHER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.PUBLISHING).push(wrapper);
				}
			}
		}
	}

	private registerCommandHandlers() {
		for (const { metatype, instance } of this.handlers.get(HandlerType.COMMAND) || []) {
			const { command } = getCommandHandlerMetadata(metatype as Type<ICommandHandler>);

			if (!command) {
				throw new MissingCommandHandlerMetadataException(metatype);
			}

			const { id } = getCommandMetadata(command);

			if (!id) {
				throw new MissingCommandMetadataException(command);
			}

			this.commandBus.bind(instance as ICommandHandler, id);
		}
	}

	private registerQueryHandlers() {
		for (const { metatype, instance } of this.handlers.get(HandlerType.QUERY) || []) {
			const { query } = getQueryHandlerMetadata(metatype as Type<IQueryHandler>);

			if (!query) {
				throw new MissingQueryHandlerMetadataException(metatype);
			}

			const { id } = getQueryMetadata(query);

			if (!id) {
				throw new MissingQueryMetadataException(query);
			}

			this.queryBus.bind(instance as IQueryHandler, id);
		}
	}

	private registerEventSerializers() {
		for (const event of this.options?.events || []) {
			const handler = this.handlers.get(HandlerType.SERIALIZATION)?.find(({ metatype }) => {
				const { event: registeredEvent } = getEventSerializerMetadata(metatype as Type<IEventSerializer>);
				return registeredEvent === event;
			});

			const serializer =
				handler?.instance || (!this.options.disableDefaultSerializer && DefaultEventSerializer.for(event));

			this.eventMap.register(event, serializer as IEventSerializer);
		}
	}

	private registerEventHandlers() {
		for (const { metatype, instance } of this.handlers.get(HandlerType.EVENT) || []) {
			const { events } = getEventHandlerMetadata(metatype as Type<IEventHandler>);

			if (!events) {
				throw new MissingEventHandlerMetadataException(metatype);
			}

			for (const event of events) {
				const { name } = getEventMetadata(event);

				if (!name) {
					throw new MissingEventMetadataException(event);
				}

				this.eventBus.bind(instance as IEventHandler, name);
			}
		}
	}

	private registerEventPublishers() {
		for (const { instance } of this.handlers.get(HandlerType.PUBLISHING) || []) {
			this.eventBus.addPublisher(instance as IEventPublisher);
		}
	}

	private registerEventStore() {
		this.eventStore.publish = this.eventBus.publish;
	}
}
