import { DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommandBus } from './command-bus';
import { HandlersLoader } from './handlers.loader';
import { EventSourcingModuleOptions } from './interfaces';
import { QueryBus } from './query-bus';

@Module({})
export class EventSourcingModule {
  static forRoot(options?: EventSourcingModuleOptions): DynamicModule {
    return {
      module: EventSourcingModule,
      imports: [DiscoveryModule, EventEmitterModule.forRoot()],
      providers: [CommandBus, QueryBus, HandlersLoader],
      exports: [CommandBus, QueryBus],
    };
  }
}
