import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import {
	MariaDBEventStore,
	type MariaDBEventStoreConfig,
	MariaDBSnapshotStore,
	type MariaDBSnapshotStoreConfig,
} from '@ocoda/event-sourcing-mariadb';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';
import { mariadbTestConfig } from '@ocoda/event-sourcing-testing/unit';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<MariaDBEventStoreConfig, MariaDBSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
				eventStore: {
					driver: MariaDBEventStore,
					...mariadbTestConfig(),
					useDefaultPool: false,
				},
				snapshotStore: {
					driver: MariaDBSnapshotStore,
					...mariadbTestConfig(),
					useDefaultPool: false,
				},
			}),
		}),
	],
	providers: testProviders,
})
export class AppModule {}
