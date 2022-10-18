import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	Aggregates,
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
  ],
})
export class AppModule {}
