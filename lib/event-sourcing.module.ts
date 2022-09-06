import { DynamicModule, Module, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommandBus } from './command-bus';
import { EVENT_SOURCING_MODULE_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventPublisher } from './event-publisher';
import { EventStore } from './event-store';
import { HandlersLoader } from './handlers.loader';
import { InMemoryEventStore } from './integration/event-store';
import { InMemorySnapshotStore } from './integration/snapshot-store';
import { EventSourcingModuleOptions } from './interfaces';
import { QueryBus } from './query-bus';
import { SnapshotStore } from './snapshot-store';

@Module({})
export class EventSourcingModule {
	static forRoot(options: EventSourcingModuleOptions): DynamicModule {
		const providers: Provider[] = [
			{ provide: EVENT_SOURCING_MODULE_OPTIONS, useValue: options },
			{ provide: EventStore, useClass: InMemoryEventStore },
			{ provide: SnapshotStore, useClass: InMemorySnapshotStore },
			CommandBus,
			EventMap,
			EventPublisher,
			HandlersLoader,
			QueryBus,
		];

		return {
			module: EventSourcingModule,
			imports: [DiscoveryModule, EventEmitterModule.forRoot()],
			providers,
			exports: [CommandBus, QueryBus, EventPublisher, EventStore, SnapshotStore, EventMap],
		};
	}
}
