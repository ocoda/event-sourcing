import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	Controllers,
	Events,
	QueryHandlers,
	SnapshotRepositories,
} from '@ocoda/event-sourcing-example/src/app.providers';
import {
	MongoDBEventStore,
	type MongoDBEventStoreConfig,
	MongoDBSnapshotStore,
	type MongoDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mongodb';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MongoDBEventStoreConfig, MongoDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: [...Events],
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
