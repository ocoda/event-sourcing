import { MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing/testing';
import { dropCollections } from '../support/catalog.js';
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
					await dropCollections(store['database'], collections);
					await store.disconnect();
				},
			};
		},
		{
			skip: {
				// Snapshot stores keep the 3.x semantics for pools that were never created (ADR 0001 D4): MongoDB reads from a
				// collection that doesn't exist as from an empty one, so reads yield nothing or undefined.
				'unknown-pool-read':
					'reads from a collection that does not exist yield nothing instead of failing (3.x semantics, D4)',
				// TODO: payloads are stored as BSON documents, so a Date is stored and returned as a Date instead of the
				// ISO-8601 string the SQL stores return. Changing it changes what existing documents hold.
				'payload-dates-as-iso-strings': 'dates are stored as BSON dates and come back as Date instances',
			},
		},
	);
}
