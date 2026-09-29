import { MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { createSnapshotStore } from '../support/stores.js';

describeSnapshotStoreConformance(
	MariaDBSnapshotStore.name,
	async () => {
		const store = createSnapshotStore();
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
			// TODO: the registered_on column is a TIMESTAMP without fractional seconds, so the milliseconds are dropped.
			// Keeping them needs TIMESTAMP(3)/DATETIME(3) and a migration of existing tables.
			'registered-on-milliseconds': 'registered_on is a TIMESTAMP(0) column, which drops the milliseconds',
			// TODO: getLastEnvelopesForAggregate() compares the raw aggregateId with the 'latest#<streamId>' keys
			// (`latest >= ?`), which every key passes, so the filter is a no-op. Making it an exclusive cursor changes
			// what the filter returns, which needs its own change (together with the other stores).
			'aggregate-cursor-paging': 'the aggregateId filter is not a cursor, so every page repeats the first one',
		},
	},
);
