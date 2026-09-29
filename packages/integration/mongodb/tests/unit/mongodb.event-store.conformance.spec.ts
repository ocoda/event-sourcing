import type { IEventCollection } from '@ocoda/event-sourcing';
import { MongoDBEventStore } from '@ocoda/event-sourcing-mongodb';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';
import { mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import type { Db, Document } from 'mongodb';
import { dropCollections } from '../support/catalog.js';
import { createEventStore } from '../support/stores.js';

/**
 * Makes every insert of an event with the given name fail from inside the write: the collection's validator also
 * requires another event name, so the insert fails with a validation error (121) and the store has to undo the rest of
 * the append. Restores the validator afterwards.
 */
const failInsertOf = async (database: Db, collection: IEventCollection, eventName: string) => {
	const [info] = await database.listCollections({ name: collection }).toArray();
	const validator = (info as { options?: { validator?: Document } }).options?.validator ?? {};
	await database.command({ collMod: collection, validator: { $and: [validator, { event: { $ne: eventName } }] } });
	return async () => {
		await database.command({ collMod: collection, validator });
	};
};

for (const { name, url } of mongodbTestTopologies()) {
	describeEventStoreConformance(
		`${MongoDBEventStore.name} (${name})`,
		async (context) => {
			const { store } = createEventStore({ url }, context);
			await store.connect();
			const database: Db = store['database'];

			return {
				store,
				cleanup: async (collections) => {
					await dropCollections(database, collections);
					await store.disconnect();
				},
				faults: { failInsertOf: (collection, eventName) => failInsertOf(database, collection, eventName) },
			};
		},
		{
			skip: {
				// TODO: payloads are stored as BSON documents, so a Date is stored and returned as a Date instead of the
				// ISO-8601 string the SQL stores return. Changing it changes what existing documents hold.
				'payload-dates-as-iso-strings': 'dates are stored as BSON dates and come back as Date instances',
			},
		},
	);
}
