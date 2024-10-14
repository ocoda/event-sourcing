import { Module } from '@nestjs/common';
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
	PostgresEventStore,
	type PostgresEventStoreConfig,
	PostgresSnapshotStore,
	type PostgresSnapshotStoreConfig,
} from '@ocoda/event-sourcing-postgres';
import { bootstrap } from './bootstrap';

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

bootstrap(AppModule);
