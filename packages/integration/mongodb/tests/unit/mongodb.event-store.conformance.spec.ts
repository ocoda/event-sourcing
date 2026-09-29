import { MongoDBEventStore } from '@ocoda/event-sourcing-mongodb';
import { LEGACY_DRIVER_SKIPS, describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { createEventStore } from '../support/stores.js';

for (const { name, url } of mongodbTestTopologies()) {
	describeEventStoreConformance(
		`${MongoDBEventStore.name} (${name})`,
		async (context) => {
			const { store } = createEventStore({ url }, context);
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
				...LEGACY_DRIVER_SKIPS,
				// TODO: MongoDB reads from a collection that doesn't exist as an empty one, so getEvents and getEnvelopes
				// yield nothing and getEvent/getEnvelope throw an EventNotFoundException. Fixed with schema v2 (catalog).
				'unknown-pool-read': 'reads from a collection that does not exist yield nothing instead of failing',
				// TODO: payloads are stored as BSON documents, so a Date is stored and returned as a Date instead of the
				// ISO-8601 string the SQL stores return. Changing it changes what existing documents hold.
				'payload-dates-as-iso-strings': 'dates are stored as BSON dates and come back as Date instances',
			},
		},
	);
}
