import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MariaDBEventStore,
	type MariaDBEventStoreConfig,
	MariaDBSnapshotStore,
	type MariaDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mariadb';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MariaDBEventStoreConfig, MariaDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
				eventStore: {
					driver: MariaDBEventStore,
					host: '127.0.0.1',
					port: 3306,
					user: 'mariadb',
					password: 'mariadb',
					database: 'mariadb',
					useDefaultPool: false,
				},
				snapshotStore: {
					driver: MariaDBSnapshotStore,
					host: '127.0.0.1',
					port: 3306,
					user: 'mariadb',
					password: 'mariadb',
					database: 'mariadb',
					useDefaultPool: false,
				},
			}),
		}),
	],
	providers: testProviders,
})
export class AppModule {}
