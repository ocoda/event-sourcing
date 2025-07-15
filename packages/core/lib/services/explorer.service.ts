import { Injectable, type Type } from '@nestjs/common';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';

import type { Module } from '@nestjs/core/injector/module';
// biome-ignore lint/style/useImportType: used in di
import { ModulesContainer } from '@nestjs/core/injector/modules-container';

import {
	COMMAND_HANDLER_METADATA,
	EVENT_PUBLISHER_METADATA,
	EVENT_SERIALIZER_METADATA,
	EVENT_SUBSCRIBER_METADATA,
	InjectEventSourcingOptions,
	QUERY_HANDLER_METADATA,
} from '../decorators';
import type {
	EventSourcingModuleOptions,
	ICommandHandler,
	IEvent,
	IEventPublisher,
	IEventSerializer,
	IEventSubscriber,
	IQueryHandler,
} from '../interfaces';
import { EventRegistry } from '../registries';

export type ProvidersIntrospectionResult = {
	sagas?: InstanceWrapper[];
	events?: Type<IEvent>[];
	queries?: InstanceWrapper<IQueryHandler>[];
	commands?: InstanceWrapper<ICommandHandler>[];
	eventPublishers?: InstanceWrapper<IEventPublisher>[];
	eventSubscribers?: InstanceWrapper<IEventSubscriber>[];
	eventSerializers?: InstanceWrapper<IEventSerializer>[];
};

@Injectable()
export class ExplorerService<EventBase extends IEvent = IEvent> {
	constructor(
		@InjectEventSourcingOptions()
		private readonly options: EventSourcingModuleOptions,
		private readonly modulesContainer: ModulesContainer,
	) {}

	get events(): Type<IEvent>[] {
		return [...(this.options.events ?? []), ...EventRegistry.getEvents()];
	}

	explore(): ProvidersIntrospectionResult {
		// get all modules from the module container
		const modules = [...this.modulesContainer.values()];

		// deliver what we need
		return {
			sagas: [],
			events: this.events,
			queries: this.flatMap<IQueryHandler>(modules, (instance) =>
				this.filterByMetadataKey(instance, QUERY_HANDLER_METADATA),
			),
			commands: this.flatMap<ICommandHandler>(modules, (instance) =>
				this.filterByMetadataKey(instance, COMMAND_HANDLER_METADATA),
			),
			eventPublishers: this.flatMap<IEventPublisher>(modules, (instance) =>
				this.filterByMetadataKey(instance, EVENT_PUBLISHER_METADATA),
			),
			eventSubscribers: this.flatMap<IEventSubscriber>(modules, (instance) =>
				this.filterByMetadataKey(instance, EVENT_SUBSCRIBER_METADATA),
			),
			eventSerializers: this.flatMap<IEventSerializer>(modules, (instance) =>
				this.filterByMetadataKey(instance, EVENT_SERIALIZER_METADATA),
			),
		};
	}

	flatMap<T extends object>(
		modules: Module[],
		callback: (instance: InstanceWrapper) => InstanceWrapper | undefined,
	): InstanceWrapper<T>[] {
		const items = modules
			.map((moduleRef) => [...moduleRef.providers.values()].map(callback))
			.reduce((a, b) => a.concat(b), []);
		return items.filter((item) => !!item) as InstanceWrapper<T>[];
	}

	filterByMetadataKey(wrapper: InstanceWrapper, metadataKey: string) {
		const { instance } = wrapper;
		if (!instance) {
			return;
		}
		if (!instance.constructor) {
			return;
		}
		const metadata = Reflect.getMetadata(metadataKey, instance.constructor);
		if (!metadata) {
			return;
		}
		return wrapper;
	}
}
