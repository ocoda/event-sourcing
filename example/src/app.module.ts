import { Module, OnModuleInit } from '@nestjs/common';
import { EventSourcingModule, EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	EventListeners,
	Events,
	QueryHandlers,
	SnapshotHandlers,
} from './app.providers';
import { AccountController } from './application/account.controller';

@Module({
  imports: [
    EventSourcingModule.forRootAsync({
      useFactory: () => ({
		eventStore: { client: 'in-memory' },
		snapshotStore: { client: 'in-memory' },
		events: [...Events],
	  }),
    }),
  ],
  providers: [
    ...AggregateRepositories,
    ...CommandHandlers,
    ...QueryHandlers,
    ...SnapshotHandlers,
	...EventListeners,
  ],
  controllers: [AccountController]
})
export class AppModule implements OnModuleInit {
	constructor(private readonly eventStore: EventStore, private readonly snapshotStore: SnapshotStore) {}

	onModuleInit() {
		this.eventStore.setup();
		this.snapshotStore.setup();
	}
}
