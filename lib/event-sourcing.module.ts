import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommandBus } from './command-bus';
import { EventPublisher } from './event-publisher';
import { EventSerializer } from './event-serializer';
import { EventStore } from './event-store';
import { HandlersLoader } from './handlers.loader';
import { DefaultEventSerializer } from './helpers/default-event-serializer';
import { InMemoryEventStore } from './integration/event-store';
import { EventSourcingModuleOptions } from './interfaces';
import { QueryBus } from './query-bus';

@Module({})
export class EventSourcingModule {
  static forRoot(options: EventSourcingModuleOptions): DynamicModule {
    const providers: Provider[] = [
      CommandBus,
      QueryBus,
      HandlersLoader,
      EventPublisher,
      { provide: EventStore, useClass: InMemoryEventStore },
      { provide: EventSerializer, useClass: DefaultEventSerializer },
    ];

    return {
      module: EventSourcingModule,
      imports: [DiscoveryModule, EventEmitterModule.forRoot()],
      providers,
      exports: [CommandBus, QueryBus, EventPublisher, EventStore],
    };
  }
}
