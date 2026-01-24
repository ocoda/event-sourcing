import { DeleteTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventStore, SnapshotStore } from '@ocoda/event-sourcing';
import type { DynamoDBEventStore, DynamoDBSnapshotStore } from '@ocoda/event-sourcing-dynamodb';
import { createDefaultStoreSetup, defaultCleanup, runAccountLifecycleE2E } from '@ocoda/event-sourcing-testing/e2e';
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
				eventStore: appRef.get<DynamoDBEventStore>(EventStore),
				snapshotStore: appRef.get<DynamoDBSnapshotStore>(SnapshotStore),
			}),
			getCleanupContext: (eventStore, snapshotStore) => ({
				// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the event collection
				eventStoreClient: eventStore['client'] as DynamoDBClient,
				// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the snapshot collection
				snapshotStoreClient: snapshotStore['client'] as DynamoDBClient,
			}),
			cleanup: async (context) =>
				defaultCleanup.dynamodb({
					eventStoreClient: context.eventStoreClient,
					snapshotStoreClient: context.snapshotStoreClient,
					deleteTable: (tableName) => new DeleteTableCommand({ TableName: tableName }),
				}),
		}),
	});
});
