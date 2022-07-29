import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { TestCommandHandlers, TestQueryHandlers } from './app.providers';
import { FooEvent, FooEventSerializer } from './foo.event';

@Module({
  imports: [
    EventSourcingModule.forRoot({
      eventMap: [[FooEvent, FooEventSerializer]],
    }),
  ],
  providers: [...TestCommandHandlers, ...TestQueryHandlers],
})
export class AppModule {}
