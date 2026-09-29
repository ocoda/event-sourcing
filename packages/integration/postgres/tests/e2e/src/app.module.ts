import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	PostgresEventStore,
	type PostgresEventStoreConfig,
	PostgresSnapshotStore,
	type PostgresSnapshotStoreConfig,
} from '@ocoda/event-sourcing-postgres';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';
import { postgresTestConfig } from '@ocoda/event-sourcing-testing/unit';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<PostgresEventStoreConfig, PostgresSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
				eventStore: {
					driver: PostgresEventStore,
					...postgresTestConfig(),
					useDefaultPool: false,
				},
				snapshotStore: {
					driver: PostgresSnapshotStore,
					...postgresTestConfig(),
					useDefaultPool: false,
				},
			}),
		}),
	],
	providers: testProviders,
})
export class AppModule {}
