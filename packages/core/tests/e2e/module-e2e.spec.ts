import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import { createDefaultStoreSetup, runAccountLifecycleE2E } from '@ocoda/event-sourcing-testing/e2e';
import type { InMemoryEventStore, InMemorySnapshotStore } from '@ocoda/event-sourcing/integration';
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
				eventStore: appRef.get<InMemoryEventStore>(EventStore),
				snapshotStore: appRef.get<InMemorySnapshotStore>(SnapshotStore),
			}),
			getCleanupContext: (_eventStore, _snapshotStore, _collectionName) => ({
				cleanup: async () => Promise.resolve(),
			}),
			cleanup: async (context) => context.cleanup(),
		}),
	});
});
