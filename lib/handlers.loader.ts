import { Injectable, OnApplicationBootstrap, Type } from '@nestjs/common';
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
import {
	MissingCommandHandlerMetadataException,
	MissingCommandMetadataException,
	MissingEventHandlerMetadataException,
	MissingEventMetadataException,
	MissingEventSerializerMetadataException,
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
import { AggregateRoot } from './models';
import { QueryBus } from './query-bus';

enum HandlerType {
	COMMANDS,
	QUERIES,
	EVENTS,
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
		private readonly eventMap: EventMap,
	) {}

	onApplicationBootstrap() {
		this.loadHandlers();

		this.registerCommandHandlers();
		this.registerQueryHandlers();
		this.registerEventSerializers();
		this.registerEventHandlers();

		this.registerEvents();
		this.registerAggregates();
	}

	private loadHandlers() {
		const providers = this.discoveryService.getProviders();

		providers.forEach((wrapper) => {
			if (wrapper.metatype) {
				if (Reflect.hasMetadata(COMMAND_HANDLER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.COMMANDS).push(wrapper);
				}
				if (Reflect.hasMetadata(QUERY_HANDLER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.QUERIES).push(wrapper);
				}
				if (Reflect.hasMetadata(EVENT_HANDLER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.EVENTS).push(wrapper);
				}
				if (Reflect.hasMetadata(EVENT_SERIALIZER_METADATA, wrapper.metatype)) {
					this.handlers.get(HandlerType.SERIALIZATION).push(wrapper);
				}
			}
		});
	}

	private registerCommandHandlers() {
		this.handlers.get(HandlerType.COMMANDS)?.forEach(({ metatype, instance }) => {
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
		this.handlers.get(HandlerType.QUERIES)?.forEach(({ metatype, instance }) => {
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
		this.handlers.get(HandlerType.SERIALIZATION)?.forEach(({ metatype }) => {
			const { event } = getEventSerializerMetadata(metatype);

			if (!event) {
				throw new MissingEventSerializerMetadataException(metatype);
			}
		});
	}

	private registerEventHandlers() {
		this.handlers.get(HandlerType.EVENTS)?.forEach(({ metatype, instance }) => {
			const { events } = getEventHandlerMetadata(metatype);

			if (!events) {
				throw new MissingEventHandlerMetadataException(metatype);
			}

			events.forEach((event) => {
				const { id } = getEventMetadata(event);

				if (!id) {
					throw new MissingEventMetadataException(event);
				}

				this.eventBus.bind(instance, id);
			});
		});
	}

	private registerEvents() {
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

	private registerAggregates() {
		this.options?.aggregates.forEach((aggregate: Type<AggregateRoot>) => {
			aggregate.prototype.publish = this.eventBus.publish;
			aggregate.prototype.publishAll = this.eventBus.publishAll;
		});
	}
}
