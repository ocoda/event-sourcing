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
	MariaDBEventStore,
	type MariaDBEventStoreConfig,
	MariaDBSnapshotStore,
	type MariaDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mariadb';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MariaDBEventStoreConfig, MariaDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: [...Events],
				eventStore: {
					driver: MariaDBEventStore,
					host: '127.0.0.1',
					port: 3306,
					user: 'mariadb',
					password: 'mariadb',
					database: 'mariadb',
				},
				snapshotStore: {
					driver: MariaDBSnapshotStore,
					host: '127.0.0.1',
					port: 3306,
					user: 'mariadb',
					password: 'mariadb',
					database: 'mariadb',
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
