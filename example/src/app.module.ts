import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MongoDBEventStore,
	type MongoDBEventStoreConfig,
	MongoDBSnapshotStore,
	type MongoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mongodb';
import { CatalogueModule } from './catalogue/catalogue.module';
import { LoaningModule } from './loaning/loaning.module';

@Module({
	imports: [
		// EventSourcingModule.forRoot<MongoDBEventStoreConfig, MongoDBSnapshotStoreConfig>({
		// 	events: [...CatalogueEvents, ...LoaningEvents],
		// 	eventStore: {
		// 		driver: MongoDBEventStore,
		// 		url: 'mongodb://127.0.0.1:27017',
		// 	},
		// 	snapshotStore: {
		// 		driver: MongoDBSnapshotStore,
		// 		url: 'mongodb://127.0.0.1:27017',
		// 	},
		// }),
		EventSourcingModule.forRootAsync<MongoDBEventStoreConfig, MongoDBSnapshotStoreConfig>({
			useFactory: () => ({
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
		CatalogueModule,
		LoaningModule,
	],
})
export class AppModule {}
