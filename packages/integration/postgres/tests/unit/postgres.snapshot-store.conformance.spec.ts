import { PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { createSnapshotStore, dropCollections } from '../support/stores.js';

describeSnapshotStoreConformance(PostgresSnapshotStore.name, async () => {
	const store = createSnapshotStore({ application_name: 'postgres-snapshot-store-conformance' });
	await store.connect();

	return {
		store,
		cleanup: async (collections) => {
			await dropCollections(store['pool']!, collections);
			await store.disconnect();
		},
	};
});
