import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import type { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { createDefaultStoreSetup, defaultCleanup, runAccountLifecycleE2E } from '@ocoda/event-sourcing-testing/e2e';
import type { Pool } from 'pg';
import { AppModule } from './src/app.module';

describe('EventSourcingModule - e2e', () => {
	let app!: INestApplication;
	const appRef: { current?: INestApplication } = {};

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
		appRef.current = app;
	});

	runAccountLifecycleE2E({
		appRef,
		storeSetup: createDefaultStoreSetup({
			resolveStores: async (appRef) => ({
				eventStore: appRef.get<PostgresEventStore>(EventStore),
				snapshotStore: appRef.get<PostgresSnapshotStore>(SnapshotStore),
			}),
			getCleanupContext: (eventStore, snapshotStore) => ({
				eventStorePool: eventStore['pool'] as Pool,
				snapshotStorePool: snapshotStore['pool'] as Pool,
			}),
			cleanup: async (context) => defaultCleanup.postgres(context.eventStorePool, context.snapshotStorePool),
		}),
	});
});
