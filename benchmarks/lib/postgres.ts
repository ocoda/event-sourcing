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
	PostgresEventStore,
	type PostgresEventStoreConfig,
	PostgresSnapshotStore,
	type PostgresSnapshotStoreConfig,
} from '@ocoda/event-sourcing-postgres';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>({
			useFactory: () => ({
				events: [...Events],
				eventStore: {
					driver: PostgresEventStore,
					host: '127.0.0.1',
					port: 5432,
					user: 'postgres',
					password: 'postgres',
					database: 'postgres',
				},
				snapshotStore: {
					driver: PostgresSnapshotStore,
					host: '127.0.0.1',
					port: 5432,
					user: 'postgres',
					password: 'postgres',
					database: 'postgres',
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
