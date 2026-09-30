import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	PostgresEventStore,
	type PostgresEventStoreConfig,
	PostgresSnapshotStore,
	type PostgresSnapshotStoreConfig,
} from '@ocoda/event-sourcing-postgres';
import { CatalogueModule } from './catalogue/catalogue.module.js';
import { EventLogModule } from './event-log/event-log.module.js';
import { EventSourcingExceptionFilter } from './event-sourcing-exception.filter.js';
import { LoaningModule } from './loaning/loaning.module.js';

/** The `postgres` service of the repository's docker-compose.yml. */
export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

@Module({
	imports: [
		// forRootAsync reads DATABASE_URL when the application starts rather than when this file is imported. Each feature
		// module registers its own events with forFeature, so the root module lists none.
		EventSourcingModule.forRootAsync<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>({
			useFactory: () => {
				const connectionString = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
				return {
					// Each store connects while the application starts and creates its default table if it's missing
					// (`ddl: 'auto'`), so a fresh database needs no setup. A 3.x database fails the start until it's
					// migrated, offline: see https://ocoda.github.io/event-sourcing/integrations/postgres#migrating-from-3x
					eventStore: { driver: PostgresEventStore, connectionString },
					snapshotStore: { driver: PostgresSnapshotStore, connectionString },
				};
			},
		}),
		CatalogueModule,
		LoaningModule,
		EventLogModule,
	],
	providers: [{ provide: APP_FILTER, useClass: EventSourcingExceptionFilter }],
})
export class AppModule {}
