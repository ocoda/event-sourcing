import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import type { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { createDefaultStoreSetup, defaultCleanup, runAccountLifecycleE2E } from '@ocoda/event-sourcing-testing/e2e';
import type { PoolClient } from 'pg';
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
			getCleanupContext: (eventStore, snapshotStore, collectionName) => ({
				// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the event collection
				eventStoreClient: eventStore['client'] as PoolClient,
				// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the snapshot collection
				snapshotStoreClient: snapshotStore['client'] as PoolClient,
				collectionName,
			}),
			cleanup: async (context) =>
				defaultCleanup.postgres(context.eventStoreClient, context.snapshotStoreClient, context.collectionName),
		}),
	});
});
