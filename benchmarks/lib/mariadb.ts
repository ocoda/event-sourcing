import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MariaDBEventStore,
	type MariaDBEventStoreConfig,
	MariaDBSnapshotStore,
	type MariaDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mariadb';
import { bootstrap } from './bootstrap';
import { CatalogueModule } from '@ocoda/event-sourcing-example/catalogue/catalogue.module';
import { LoaningModule } from '@ocoda/event-sourcing-example/loaning/loaning.module';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MariaDBEventStoreConfig, MariaDBSnapshotStoreConfig>({
			useFactory: () => ({
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
		CatalogueModule,
		LoaningModule,
	],
})
class AppModule {}

bootstrap(AppModule);
