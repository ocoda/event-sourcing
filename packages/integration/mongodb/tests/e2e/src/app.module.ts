import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MongoDBEventStore,
	type MongoDBEventStoreConfig,
	MongoDBSnapshotStore,
	type MongoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mongodb';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MongoDBEventStoreConfig, MongoDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
				eventStore: {
					driver: MongoDBEventStore,
					url: 'mongodb://localhost:27017',
					useDefaultPool: false,
				},
				snapshotStore: {
					driver: MongoDBSnapshotStore,
					url: 'mongodb://localhost:27017',
					useDefaultPool: false,
				},
			}),
		}),
	],
	providers: testProviders,
})
export class AppModule {}
