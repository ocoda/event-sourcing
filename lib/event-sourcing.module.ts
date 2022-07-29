import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { CommandBus } from './command-bus';
import { EventPublisher } from './event-publisher';
import { EventTransformer } from './event-transformer';
import { HandlersLoader } from './handlers.loader';
import { EventSourcingModuleOptions } from './interfaces';
import { QueryBus } from './query-bus';

@Module({})
export class EventSourcingModule {
  static forRoot(options: EventSourcingModuleOptions): DynamicModule {
    const eventTransformerProvider: Provider = {
      provide: EventTransformer,
      useValue: new EventTransformer(options.eventMap),
    };

    return {
      module: EventSourcingModule,
      imports: [DiscoveryModule, EventEmitterModule.forRoot()],
      providers: [
        CommandBus,
        QueryBus,
        HandlersLoader,
        EventPublisher,
        eventTransformerProvider,
      ],
      exports: [CommandBus, QueryBus, EventPublisher, EventTransformer],
    };
  }
}
