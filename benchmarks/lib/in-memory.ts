import { Module } from '@nestjs/common';
import {} from '@nestjs/core';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	Controllers,
	Events,
	QueryHandlers,
	SnapshotRepositories,
} from '@ocoda/event-sourcing-example';
import { bootstrap } from './bootstrap';

@Module({
	imports: [EventSourcingModule.forRoot({ events: Events })],
	providers: [...AggregateRepositories, ...CommandHandlers, ...QueryHandlers, ...SnapshotRepositories],
	controllers: [...Controllers],
})
class AppModule {}

bootstrap(AppModule);
