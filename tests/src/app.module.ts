import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
  Events,
  CommandHandlers,
  QueryHandlers,
  SnapshotHandlers,
  AggregateRepositories,
} from './app.providers';

@Module({
  imports: [
    EventSourcingModule.forRoot({
      events: [...Events],
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
