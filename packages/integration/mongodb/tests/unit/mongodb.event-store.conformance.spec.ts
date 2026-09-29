import { MongoDBEventStore } from '@ocoda/event-sourcing-mongodb';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { createEventStore } from '../support/stores.js';

describe.each(mongodbTestTopologies())('$name', ({ url }) => {
	describeEventStoreConformance(
		MongoDBEventStore.name,
		async (eventMap) => {
			const { store } = createEventStore({ url }, eventMap);
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
				// TODO: MongoDB reads from a collection that doesn't exist as an empty one, so getEvents, getEnvelopes and
				// getAllEnvelopes yield nothing and getEvent/getEnvelope throw an EventNotFoundException.
				'unknown-pool-read': 'reads from a collection that does not exist yield nothing instead of failing',
				// TODO: payloads are stored as BSON documents, so a Date is stored and returned as a Date instead of the
				// ISO-8601 string the SQL stores return. Changing it changes what existing documents hold.
				'payload-dates-as-iso-strings': 'dates are stored as BSON dates and come back as Date instances',
			},
		},
	);
});
