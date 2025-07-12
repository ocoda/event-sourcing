import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	Controllers,
	Events,
	QueryHandlers,
	SnapshotRepositories,
} from './catalogue.providers';
import { APP_FILTER } from '@nestjs/core';
import { DomainExceptionsFilter } from './application/exceptions';

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
export class CatalogueModule {}
