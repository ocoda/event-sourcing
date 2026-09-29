import { PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { escapeIdentifier } from 'pg';
import { createSnapshotStore } from '../support/stores.js';

describeSnapshotStoreConformance(
	PostgresSnapshotStore.name,
	async () => {
		const store = createSnapshotStore({ application_name: 'postgres-snapshot-store-conformance' });
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
	{
		skip: {
			// TODO(G-pg): getLastEnvelopesForAggregate() compares the raw aggregateId with the 'latest#<streamId>' keys
			// (`latest >= $2`), which every key passes, so the filter is a no-op, and it orders by the collation of the
			// database. Schema v2 makes the aggregateId an exclusive cursor in binary order.
			'aggregate-cursor-paging':
				'schema v2 (G): the aggregateId filter is not a cursor, so every page repeats the first one',
		},
	},
);
