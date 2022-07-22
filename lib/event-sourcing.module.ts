import { DynamicModule, Module, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { CommandBus } from './command-bus';
import { EventPublisher } from './event-publisher';
import { HandlersLoader } from './handlers.loader';
import { EventSourcingModuleOptions } from './interfaces';
import { QueryBus } from './query-bus';

@Module({})
export class EventSourcingModule {
  static forRoot(options?: EventSourcingModuleOptions): DynamicModule {
    return {
      module: EventSourcingModule,
      imports: [DiscoveryModule, EventEmitterModule.forRoot()],
      providers: [CommandBus, QueryBus, HandlersLoader, EventPublisher],
      exports: [CommandBus, QueryBus, EventPublisher],
    };
  }
}
