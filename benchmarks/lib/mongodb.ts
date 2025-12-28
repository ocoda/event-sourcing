import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MongoDBEventStore,
	type MongoDBEventStoreConfig,
	MongoDBSnapshotStore,
	type MongoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mongodb';
import { bootstrap } from './bootstrap';
import { CatalogueModule } from '@ocoda/event-sourcing-example/catalogue/catalogue.module';
import { LoaningModule } from '@ocoda/event-sourcing-example/loaning/loaning.module';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MongoDBEventStoreConfig, MongoDBSnapshotStoreConfig>({
			useFactory: () => ({
				eventStore: {
					driver: MongoDBEventStore,
					url: 'mongodb://localhost:27017',
				},
				snapshotStore: {
					driver: MongoDBSnapshotStore,
					url: 'mongodb://localhost:27017',
				},
			}),
		}),
		CatalogueModule,
		LoaningModule,
	],
})
class AppModule {}

bootstrap(AppModule);
