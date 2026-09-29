import { PostgresEventStore } from '@ocoda/event-sourcing-postgres';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { escapeIdentifier } from 'pg';

describeEventStoreConformance(PostgresEventStore.name, async (eventMap) => {
	const store = new PostgresEventStore(eventMap, {
		driver: undefined as never,
		host: '127.0.0.1',
		port: 5432,
		user: 'postgres',
		password: 'postgres',
		database: 'postgres',
		application_name: 'postgres-event-store-conformance',
	});
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
