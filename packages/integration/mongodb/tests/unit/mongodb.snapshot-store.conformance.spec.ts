import { MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { createSnapshotStore } from '../support/stores.js';

for (const { name, url } of mongodbTestTopologies()) {
	describeSnapshotStoreConformance(
		`${MongoDBSnapshotStore.name} (${name})`,
		async () => {
			const store = createSnapshotStore({ url });
			await store.connect();

			return {
				store,
				cleanup: async (collections) => {
					for (const collection of collections) {
						await store['database'].dropCollection(collection).catch(() => undefined);
					}
					await store.disconnect();
				},
			};
		},
		{
			skip: {
				// TODO: MongoDB reads from a collection that doesn't exist as an empty one, so reads yield nothing or undefined.
				'unknown-pool-read': 'reads from a collection that does not exist yield nothing instead of failing',
				// TODO: payloads are stored as BSON documents, so a Date is stored and returned as a Date instead of the
				// ISO-8601 string the SQL stores return. Changing it changes what existing documents hold.
				'payload-dates-as-iso-strings': 'dates are stored as BSON dates and come back as Date instances',
				// TODO(G-mongo): appendSnapshot() unflags the latest snapshot and inserts the new one in two separate writes,
				// after reading the latest outside of them, so appends that race each other can leave several latest snapshots
				// (or none, or a lower version). Schema v2 enforces one latest snapshot per stream with a unique index.
				'latest-unique-concurrent':
					'schema v2 (G): racing appends can leave several latest snapshots, or flag a lower version',
				// TODO(G-mongo): getLastEnvelopesForAggregate() compares the raw aggregateId with the 'latest#<streamId>' keys
				// (`latest: { $gte: aggregateId }`), which every key passes, so the filter is a no-op. Schema v2 makes the
				// aggregateId an exclusive cursor in binary order.
				'aggregate-cursor-paging':
					'schema v2 (G): the aggregateId filter is not a cursor, so every page repeats the first one',
			},
		},
	);
}
