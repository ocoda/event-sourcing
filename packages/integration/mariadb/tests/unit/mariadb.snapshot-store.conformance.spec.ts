import { MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { createSnapshotStore, dropTables, poolOf } from '../support/stores.js';

describeSnapshotStoreConformance(MariaDBSnapshotStore.name, async () => {
	const store = createSnapshotStore();
	await store.connect();

	return {
		store,
		cleanup: async (collections) => {
			await dropTables(poolOf(store), collections);
			await store.disconnect();
		},
	};
});
