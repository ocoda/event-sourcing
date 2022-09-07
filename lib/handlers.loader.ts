import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { CommandBus, CommandHandlerType } from './command-bus';
import {
	COMMAND_HANDLER_METADATA,
	COMMAND_METADATA,
	EVENT_SERIALIZER_METADATA,
	InjectEventSourcingOptions,
	QUERY_HANDLER_METADATA,
	QUERY_METADATA,
} from './decorators';
import { EventMap } from './event-map';
import { InvalidCommandHandlerException, InvalidQueryHandlerException } from './exceptions';
import { DefaultEventSerializer } from './helpers';
import { CommandMetadata, EventSourcingModuleOptions, QueryMetadata } from './interfaces';
import { QueryBus, QueryHandlerType } from './query-bus';

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

	private registerCommandHandlers(handlers: InstanceWrapper[]) {
		handlers?.forEach(({ metatype, instance }) => {
			const command: CommandHandlerType = Reflect.getMetadata(COMMAND_HANDLER_METADATA, metatype);

			const { id }: CommandMetadata = Reflect.getMetadata(COMMAND_METADATA, command);

			if (!id) {
				throw new InvalidCommandHandlerException();
			}

			this.commandBus.bind(instance, id);
		});
	}

	private registerQueryHandlers(handlers: InstanceWrapper[]) {
		handlers?.forEach(({ metatype, instance }) => {
			const query: QueryHandlerType = Reflect.getMetadata(QUERY_HANDLER_METADATA, metatype);

			const { id }: QueryMetadata = Reflect.getMetadata(QUERY_METADATA, query);

			if (!id) {
				throw new InvalidQueryHandlerException();
			}

			this.queryBus.bind(instance, id);
		});
	}

	private registerEvents(handlers: InstanceWrapper[]) {
		this.options?.events.forEach((event) => {
			const handler = handlers?.find(
				({ metatype }) => Reflect.getMetadata(EVENT_SERIALIZER_METADATA, metatype) === event,
			);

			const serializer =
				handler?.instance || (!this.options.disableDefaultSerializer && DefaultEventSerializer.for(event));

			return this.eventMap.register(event, serializer);
		});
	}
}
