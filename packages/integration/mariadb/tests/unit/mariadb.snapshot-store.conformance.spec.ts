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
			// TODO(G-maria): appendSnapshot() reads the flagged latest snapshot before its transaction, so appends that race
			// each other can all flag their snapshot (or flag a lower version). Schema v2 enforces one latest snapshot per
			// stream with a unique index.
			'latest-unique-concurrent':
				'schema v2 (G): racing appends can leave several latest snapshots, or flag a lower version',
			// TODO(G-maria): getLastEnvelopesForAggregate() compares the raw aggregateId with the 'latest#<streamId>' keys
			// (`latest >= ?`), which every key passes, so the filter is a no-op. And the tables compare stream ids
			// case-insensitively, so streams whose ids differ in case only are one stream. Schema v2 (utf8mb4_bin) makes the
			// aggregateId an exclusive cursor in binary order.
			'aggregate-cursor-paging':
				'schema v2 (G): the aggregateId filter is not a cursor, and stream ids that differ in case only collide',
		},
	},
);
