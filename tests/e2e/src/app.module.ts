import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	EventHandlers,
	Events,
	QueryHandlers,
	SnapshotHandlers,
} from './app.providers';

@Module({
  imports: [
    EventSourcingModule.forRootAsync({
      useFactory: () => ({
		events: [...Events],
		eventStore: {
			client: 'in-memory'
		},
	  }),
    }),
  ],
  providers: [
    ...AggregateRepositories,
    ...CommandHandlers,
    ...QueryHandlers,
    ...SnapshotHandlers,
	...EventHandlers,
  ],
})
export class AppModule {}
