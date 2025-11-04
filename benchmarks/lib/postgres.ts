import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	PostgresEventStore,
	type PostgresEventStoreConfig,
	PostgresSnapshotStore,
	type PostgresSnapshotStoreConfig,
} from '@ocoda/event-sourcing-postgres';
import { bootstrap } from './bootstrap';
import { CatalogueModule } from '@ocoda/event-sourcing-example/catalogue/catalogue.module';
import { LoaningModule } from '@ocoda/event-sourcing-example/loaning/loaning.module';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>({
			useFactory: () => ({
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
		CatalogueModule,
		LoaningModule,
	],
})
class AppModule {}

bootstrap(AppModule);
