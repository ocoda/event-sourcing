import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MongoDBEventStore,
	type MongoDBEventStoreConfig,
	MongoDBSnapshotStore,
	type MongoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mongodb';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';
import { mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';

// The e2e suite runs on the standalone server, which mongodbTestTopologies() lists first.
const [{ url }] = mongodbTestTopologies();

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MongoDBEventStoreConfig, MongoDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
				eventStore: {
					driver: MongoDBEventStore,
					url,
					useDefaultPool: false,
				},
				snapshotStore: {
					driver: MongoDBSnapshotStore,
					url,
					useDefaultPool: false,
				},
			}),
		}),
	],
	providers: testProviders,
})
export class AppModule {}
