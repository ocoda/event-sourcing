import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	DynamoDBEventStore,
	type DynamoDBEventStoreConfig,
	DynamoDBSnapshotStore,
	type DynamoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-dynamodb';
import { bootstrap } from './bootstrap';
import { CatalogueModule } from '@ocoda/event-sourcing-example/catalogue/catalogue.module';
import { LoaningModule } from '@ocoda/event-sourcing-example/loaning/loaning.module';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<DynamoDBEventStoreConfig, DynamoDBSnapshotStoreConfig>({
			useFactory: () => ({
				eventStore: {
					driver: DynamoDBEventStore,
					region: 'us-east-1',
					endpoint: 'http://127.0.0.1:8000',
					credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
				},
				snapshotStore: {
					driver: DynamoDBSnapshotStore,
					region: 'us-east-1',
					endpoint: 'http://127.0.0.1:8000',
					credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
				},
			}),
		}),
		CatalogueModule,
		LoaningModule,
	],
})
class AppModule {}

bootstrap(AppModule);
