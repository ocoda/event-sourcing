import { PostgresEventStore } from '@ocoda/event-sourcing-postgres';
import { LEGACY_DRIVER_SKIPS, describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { escapeIdentifier } from 'pg';
import { createEventStore } from '../support/stores.js';

describeEventStoreConformance(
	PostgresEventStore.name,
	async (context) => {
		const { store } = createEventStore({ application_name: 'postgres-event-store-conformance' }, context);
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
	},
	{ skip: { ...LEGACY_DRIVER_SKIPS } },
);
