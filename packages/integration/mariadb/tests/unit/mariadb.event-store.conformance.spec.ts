import { MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
import { LEGACY_DRIVER_SKIPS, describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { createEventStore } from '../support/stores.js';

describeEventStoreConformance(
	MariaDBEventStore.name,
	async (context) => {
		const { store } = createEventStore({}, context);
		await store.connect();

		return {
			store,
			cleanup: async (collections) => {
				for (const collection of collections) {
					await store['pool'].query(`DROP TABLE IF EXISTS ${store['pool'].escapeId(collection)}`);
				}
				await store.disconnect();
			},
		};
	},
	{
		skip: {
			...LEGACY_DRIVER_SKIPS,
			// TODO: the occurred_on column is a TIMESTAMP without fractional seconds, so the milliseconds are dropped.
			// Keeping them needs TIMESTAMP(3)/DATETIME(3) and a migration of existing tables.
			'occurred-on-milliseconds': 'occurred_on is a TIMESTAMP(0) column, which drops the milliseconds',
		},
	},
);
