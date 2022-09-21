import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { AggregateRepositories, CommandHandlers, Events, QueryHandlers, SnapshotHandlers } from './app.providers';

@Module({
  imports: [
    EventSourcingModule.forRootAsync({
      useFactory: () => ({
		eventStore: {
			client: 'in-memory'
		},
		events: [...Events],
	  }),
    }),
  ],
  providers: [
    ...AggregateRepositories,
    ...CommandHandlers,
    ...QueryHandlers,
    ...SnapshotHandlers,
  ],
})
export class AppModule {}
