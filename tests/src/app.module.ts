import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { TestCommandHandlers } from './app.providers';

@Module({
  imports: [EventSourcingModule.forRoot()],
  providers: [...TestCommandHandlers],
})
export class AppModule {}
