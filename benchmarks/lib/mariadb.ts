import { Module } from '@nestjs/common';
import {} from '@nestjs/core';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	AggregateRepositories,
	CommandHandlers,
	Controllers,
	Events,
	QueryHandlers,
	SnapshotRepositories,
} from '@ocoda/event-sourcing-example';
import {
	MariaDBEventStore,
	type MariaDBEventStoreConfig,
	MariaDBSnapshotStore,
	type MariaDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mariadb';
import { bootstrap } from './bootstrap';

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

bootstrap(AppModule);
