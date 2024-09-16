import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	EventHandlers,
	EventPublishers,
	Events,
	QueryHandlers,
	SnapshotHandlers,
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
		...EventHandlers,
		...EventPublishers,
	],
})
export class AppModule {}
