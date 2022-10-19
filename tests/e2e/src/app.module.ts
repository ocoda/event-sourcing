import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	Aggregates,
	CommandHandlers,
	EventHandlers,
	EventPublishers,
	Events,
	QueryHandlers,
	SnapshotHandlers,
} from './app.providers';

@Module({
  imports: [
    EventSourcingModule.forRootAsync({
      useFactory: () => ({
		aggregates: [...Aggregates],
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
	...EventPublishers
  ],
})
export class AppModule {}
