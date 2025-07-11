import {Injectable} from "@nestjs/common";
import {DiscoveryService} from '@nestjs/core';
import {InstanceWrapper} from '@nestjs/core/injector/instance-wrapper';

import {Module} from '@nestjs/core/injector/module';
import {ModulesContainer} from '@nestjs/core/injector/modules-container';

import {
    EventRegistry
} from '../registries'
import {
    type IEvent,
    type IQueryHandler,
    type ICommandHandler,
    type IEventPublisher,
    type IEventSerializer,
    type IEventSubscriber,
    type EventSourcingModuleOptions,
} from "../interfaces";
import {
    QUERY_HANDLER_METADATA,
    COMMAND_HANDLER_METADATA,
    EVENT_PUBLISHER_METADATA,
    EVENT_SERIALIZER_METADATA,
    EVENT_SUBSCRIBER_METADATA,
    InjectEventSourcingOptions,
} from '../decorators';

export type ProvidersIntrospectionResult = {
    sagas?: InstanceWrapper[];
    events?: Type<IEvent>[];
    queries?: InstanceWrapper<IQueryHandler>[];
    commands?: InstanceWrapper<ICommandHandler>[];
    eventPublishers?: InstanceWrapper<IEventPublisher>[];
    eventSubscribers?: InstanceWrapper<IEventSubscriber>[];
    eventSerializers?: InstanceWrapper<IEventSerializer>[];
}

@Injectable()
export class ExplorerService<EventBase extends IEvent = IEvent> {

    constructor(
        @InjectEventSourcingOptions()
        private readonly options: EventSourcingModuleOptions,
        private readonly discoveryService: DiscoveryService,
        private readonly modulesContainer: ModulesContainer,
    ) {

    }

    get events() : Type<IEvent>[] {
        return [
            ...(this.options.events ?? []),
            ...EventRegistry.getEvents()
        ];
    }

    explore() : ProvidersIntrospectionResult {
        // get all modules from the module container
        const modules = [...this.modulesContainer.values()];

        // deliver what we need
        return {
            sagas : [],
            events: this.events,
            queries: this.flatMap<IQueryHandler>(
                modules,
                (instance) => this.filterByMetadataKey(instance, QUERY_HANDLER_METADATA)
            ),
            commands : this.flatMap<ICommandHandler>(
                modules,
                (instance) => this.filterByMetadataKey(instance, COMMAND_HANDLER_METADATA)
            ),
            eventPublishers : this.flatMap<IEventPublisher>(
                modules,
                (instance) => this.filterByMetadataKey(instance, EVENT_PUBLISHER_METADATA)
            ),
            eventSubscribers : this.flatMap<IEventSubscriber>(
                modules,
                (instance) => this.filterByMetadataKey(instance, EVENT_SUBSCRIBER_METADATA)
            ),
            eventSerializers : this.flatMap<IEventSerializer>(
                modules,
                (instance) => this.filterByMetadataKey(instance, EVENT_SERIALIZER_METADATA)
            ),
        }
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