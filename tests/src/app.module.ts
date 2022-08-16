import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { TestCommandHandlers, TestQueryHandlers } from './app.providers';

@Module({
  imports: [EventSourcingModule.forRoot()],
  providers: [...TestCommandHandlers, ...TestQueryHandlers],
})
export class AppModule {}
