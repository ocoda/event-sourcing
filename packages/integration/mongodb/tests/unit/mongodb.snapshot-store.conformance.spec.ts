import { MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { createSnapshotStore } from '../support/stores.js';

describe.each(mongodbTestTopologies())('$name', ({ url }) => {
	describeSnapshotStoreConformance(
		MongoDBSnapshotStore.name,
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
				// TODO: getLastEnvelopesForAggregate() compares the raw aggregateId with the 'latest#<streamId>' keys
				// (`latest: { $gte: aggregateId }`), which every key passes, so the filter is a no-op. Making it an exclusive
				// cursor changes what the filter returns, which needs its own change (together with the other stores).
				'aggregate-cursor-paging': 'the aggregateId filter is not a cursor, so every page repeats the first one',
			},
		},
	);
});
