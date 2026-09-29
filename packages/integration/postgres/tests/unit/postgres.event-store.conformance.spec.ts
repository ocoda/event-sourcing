import { PostgresEventStore } from '@ocoda/event-sourcing-postgres';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { createEventStore, dropCollections, failInsertOf } from '../support/stores.js';

describeEventStoreConformance(PostgresEventStore.name, async (context) => {
	const { store } = createEventStore({ application_name: 'postgres-event-store-conformance' }, context);
	await store.connect();
	const pool = store['pool']!;

	return {
		store,
		cleanup: async (collections) => {
			await dropCollections(pool, collections);
			await store.disconnect();
		},
		faults: { failInsertOf: (collection, eventName) => failInsertOf(pool, collection, eventName) },
	};
});
