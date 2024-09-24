import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	PostgresEventStore,
	type PostgresEventStoreConfig,
	PostgresSnapshotStore,
	type PostgresSnapshotStoreConfig,
} from '@ocoda/event-sourcing-postgres';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
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
	providers: testProviders,
})
export class AppModule {}
