import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import type { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { createDefaultStoreSetup, defaultCleanup, runAccountLifecycleE2E } from '@ocoda/event-sourcing-testing/e2e';
import type { Pool } from 'mariadb';
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
				eventStore: appRef.get<MariaDBEventStore>(EventStore),
				snapshotStore: appRef.get<MariaDBSnapshotStore>(SnapshotStore),
			}),
			getCleanupContext: (eventStore, snapshotStore, collectionName) => ({
				// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the event collection
				eventStoreClient: eventStore['pool'] as Pool,
				// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the snapshot collection
				snapshotStoreClient: snapshotStore['pool'] as Pool,
				collectionName,
			}),
			cleanup: async (context) =>
				defaultCleanup.mariadb(context.eventStoreClient, context.snapshotStoreClient, context.collectionName),
		}),
	});
});
