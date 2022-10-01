import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { CommandBus } from './command-bus';
import {
	COMMAND_HANDLER_METADATA,
	EVENT_SERIALIZER_METADATA,
	InjectEventSourcingOptions,
	QUERY_HANDLER_METADATA,
} from './decorators';
import { EventMap } from './event-map';
import {
	MissingCommandHandlerMetadataException,
	MissingCommandMetadataException,
	MissingEventSerializerMetadataException,
	MissingQueryHandlerMetadataException,
	MissingQueryMetadataException,
} from './exceptions';
import {
	DefaultEventSerializer,
	getCommandHandlerMetadata,
	getCommandMetadata,
	getEventSerializerMetadata,
	getQueryHandlerMetadata,
	getQueryMetadata,
} from './helpers';
import { EventSourcingModuleOptions, ICommandHandler } from './interfaces';
import { QueryBus } from './query-bus';

enum HandlerType {
	COMMANDS,
	QUERIES,
	SERIALIZATION,
}

@Injectable()
export class HandlersLoader implements OnApplicationBootstrap {
	constructor(
		@InjectEventSourcingOptions()
		private readonly options: EventSourcingModuleOptions,
		private readonly discoveryService: DiscoveryService,
		private readonly commandBus: CommandBus,
		private readonly queryBus: QueryBus,
		private readonly eventMap: EventMap,
	) {}

	onApplicationBootstrap() {
		const handlers = this.loadHandlers();

		this.registerCommandHandlers(handlers.get(HandlerType.COMMANDS));
		this.registerQueryHandlers(handlers.get(HandlerType.QUERIES));
		this.registerEvents(handlers.get(HandlerType.SERIALIZATION));
	}

	private loadHandlers() {
		const providers = this.discoveryService.getProviders();
		const handlers = new Map<HandlerType, InstanceWrapper[]>();

		providers.forEach((wrapper) => {
			if (wrapper.metatype) {
				if (Reflect.hasMetadata(COMMAND_HANDLER_METADATA, wrapper.metatype)) {
					handlers.set(HandlerType.COMMANDS, [...(handlers.get(HandlerType.COMMANDS) || []), wrapper]);
				}
				if (Reflect.hasMetadata(QUERY_HANDLER_METADATA, wrapper.metatype)) {
					handlers.set(HandlerType.QUERIES, [...(handlers.get(HandlerType.QUERIES) || []), wrapper]);
				}
				if (Reflect.hasMetadata(EVENT_SERIALIZER_METADATA, wrapper.metatype)) {
					handlers.set(HandlerType.SERIALIZATION, [...(handlers.get(HandlerType.SERIALIZATION) || []), wrapper]);
				}
			}
		});

		return handlers;
	}

	private registerCommandHandlers(handlers: InstanceWrapper<ICommandHandler>[]) {
		handlers?.forEach(({ metatype, instance }) => {
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

	private registerQueryHandlers(handlers: InstanceWrapper[]) {
		handlers?.forEach(({ metatype, instance }) => {
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

	private registerEvents(handlers: InstanceWrapper[]) {
		handlers?.forEach(({ metatype }) => {
			const { event } = getEventSerializerMetadata(metatype);

			if (!event) {
				throw new MissingEventSerializerMetadataException(metatype);
			}
		});

		this.options?.events.forEach((event) => {
			const handler = handlers?.find(({ metatype }) => {
				const { event: registeredEvent } = getEventSerializerMetadata(metatype);
				return registeredEvent === event;
			});

			const serializer =
				handler?.instance || (!this.options.disableDefaultSerializer && DefaultEventSerializer.for(event));

			return this.eventMap.register(event, serializer);
		});
	}
}
