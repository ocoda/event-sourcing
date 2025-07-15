import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { DomainExceptionsFilter } from './application/exceptions';
import {
	AggregateRepositories,
	CommandHandlers,
	Controllers,
	Events,
	QueryHandlers,
	SnapshotRepositories,
} from './loaning.providers';

@Module({
	imports: [EventSourcingModule.forFeature({ events: [...Events] })],
	providers: [
		...AggregateRepositories,
		...CommandHandlers,
		...QueryHandlers,
		...SnapshotRepositories,
		{ provide: APP_FILTER, useClass: DomainExceptionsFilter },
	],
	controllers: [...Controllers],
})
export class LoaningModule {}
