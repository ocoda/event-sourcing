import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	DynamoDBEventStore,
	type DynamoDBEventStoreConfig,
	DynamoDBSnapshotStore,
	type DynamoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-dynamodb';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<DynamoDBEventStoreConfig, DynamoDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
				eventStore: {
					driver: DynamoDBEventStore,
					region: 'us-east-1',
					endpoint: 'http://127.0.0.1:8000',
					credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
					useDefaultPool: false,
				},
				snapshotStore: {
					driver: DynamoDBSnapshotStore,
					region: 'us-east-1',
					endpoint: 'http://127.0.0.1:8000',
					credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
					useDefaultPool: false,
				},
			}),
		}),
	],
	providers: testProviders,
})
export class AppModule {}
