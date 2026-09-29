import { PostgresEventStore } from '@ocoda/event-sourcing-postgres';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { escapeIdentifier } from 'pg';
import { createEventStore } from '../support/stores.js';

describeEventStoreConformance(PostgresEventStore.name, async (eventMap) => {
	const { store } = createEventStore({ application_name: 'postgres-event-store-conformance' }, eventMap);
	await store.connect();

	return {
		store,
		cleanup: async (collections) => {
			for (const collection of collections) {
				await store['pool'].query(`DROP TABLE IF EXISTS ${escapeIdentifier(collection)}`);
			}
			await store.disconnect();
		},
	};
});
