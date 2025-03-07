import { Module } from '@nestjs/common';
import { EventSourcingModule } from '@ocoda/event-sourcing';
import type { RedisSnapshotStoreConfig } from '@ocoda/event-sourcing-redis/interfaces';
import { RedisSnapshotStore } from '@ocoda/event-sourcing-redis/redis.snapshot-store';
import { Events, testProviders } from '@ocoda/event-sourcing-testing/e2e';
import type { InMemoryEventStoreConfig } from '@ocoda/event-sourcing/integration';

@Module({
	imports: [
		EventSourcingModule.forRootAsync<InMemoryEventStoreConfig, RedisSnapshotStoreConfig>({
			useFactory: () => ({
				events: Events,
				snapshotStore: {
					driver: RedisSnapshotStore,
					url: 'redis://@127.0.0.1',
					useDefaultPool: false,
				},
			}),
		}),
	],
	providers: testProviders,
})
export class AppModule {}
