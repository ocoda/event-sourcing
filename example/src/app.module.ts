import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MongoDBEventStore,
	MongoDBEventStoreConfig,
	MongoDBSnapshotStore,
	MongoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mongodb';
import {
	AggregateRepositories,
	CommandHandlers,
	EventHandlers,
	EventPublishers,
	Events,
	QueryHandlers,
	SnapshotHandlers,
} from './app.providers';
import { AccountController } from './application/account.controller';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MongoDBEventStoreConfig, MongoDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: [...Events],
				eventStore: {
					driver: MongoDBEventStore,
					url: 'mongodb://127.0.0.1:27017',
				},
				snapshotStore: {
					driver: MongoDBSnapshotStore,
					url: 'mongodb://127.0.0.1:27017',
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
		...EventPublishers,
	],
	controllers: [AccountController],
})
export class AppModule {}
