import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	DynamoDBEventStore,
	type DynamoDBEventStoreConfig,
	DynamoDBSnapshotStore,
	type DynamoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-dynamodb';
import {
	AggregateRepositories,
	CommandHandlers,
	Controllers,
	Events,
	QueryHandlers,
	SnapshotRepositories,
} from '@ocoda/event-sourcing-example/src/app.providers';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<DynamoDBEventStoreConfig, DynamoDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: [...Events],
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
	],
	providers: [...AggregateRepositories, ...CommandHandlers, ...QueryHandlers, ...SnapshotRepositories],
	controllers: [...Controllers],
})
class AppModule {}

async function bootstrap() {
	const app = await NestFactory.create(AppModule, { logger: false });
	await app.listen(3000);
}
bootstrap();
