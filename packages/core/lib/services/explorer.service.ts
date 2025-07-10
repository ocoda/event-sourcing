import {Injectable} from "@nestjs/common";
import {DiscoveryService} from '@nestjs/core';
import {InstanceWrapper} from '@nestjs/core/injector/instance-wrapper';

import {Module} from '@nestjs/core/injector/module';
import {ModulesContainer} from '@nestjs/core/injector/modules-container';

import {
    type IEvent,
    type IQueryHandler,
    type ICommandHandler,
    type IEventPublisher,
    type IEventSerializer,
} from "../interfaces";


export type ProvidersIntrospectionResult = {
    commands?: InstanceWrapper<ICommandHandler>[];
    queries?: InstanceWrapper<IQueryHandler>[];
    events?: InstanceWrapper[];
    sagas?: InstanceWrapper[];
    publishers?: InstanceWrapper<IEventPublisher>[];
    serializers?: InstanceWrapper<IEventSerializer>[];
}

@Injectable()
export class ExplorerService<EventBase extends IEvent = IEvent> {

    constructor(
        private readonly discoveryService: DiscoveryService
    ) {

    }

    explore() : ProvidersIntrospectionResult {
        return {

        }
    }

}