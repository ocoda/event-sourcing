import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MongoDBEventStore,
	type MongoDBEventStoreConfig,
	MongoDBSnapshotStore,
	type MongoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mongodb';
import {
	AggregateRepositories,
	CommandHandlers,
	Controllers,
	EventPublishers,
	EventSubscribers,
	Events,
	QueryHandlers,
	SnapshotRepositories,
} from './app.providers';

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
		...SnapshotRepositories,
		...EventSubscribers,
		...EventPublishers,
	],
	controllers: [...Controllers],
})
export class AppModule {}
