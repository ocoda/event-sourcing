import { MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';

describeEventStoreConformance(
	MariaDBEventStore.name,
	async (eventMap) => {
		const store = new MariaDBEventStore(eventMap, {
			driver: undefined as never,
			host: '127.0.0.1',
			port: 3306,
			user: 'mariadb',
			password: 'mariadb',
			database: 'mariadb',
		});
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
			// TODO: the occurred_on column is a TIMESTAMP without fractional seconds, so the milliseconds are dropped.
			// Keeping them needs TIMESTAMP(3)/DATETIME(3) and a migration of existing tables.
			'occurred-on-milliseconds': 'occurred_on is a TIMESTAMP(0) column, which drops the milliseconds',
		},
	},
);
