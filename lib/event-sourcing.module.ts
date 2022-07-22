import { DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommandBus } from './command-bus';
// import { CommandHandlersMetadataAccessor } from './command-handler-metadata.accessor';
// import { CommandHandlersLoader } from './command-handlers.loader';
import { EventSourcingModuleOptions } from './interfaces';

@Module({})
export class EventSourcingModule {
  static forRoot(options?: EventSourcingModuleOptions): DynamicModule {
    return {
      module: EventSourcingModule,
      imports: [DiscoveryModule, EventEmitterModule.forRoot()],
      providers: [
        CommandBus,
        // CommandHandlersLoader,
        // CommandHandlersMetadataAccessor,
        //     {
        //       provide: EventEmitter2,
        //       useValue: new EventEmitter2(options),
        //     },
      ],
      exports: [CommandBus],
    };
  }
}
