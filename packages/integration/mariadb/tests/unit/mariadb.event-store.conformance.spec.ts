import { MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
import { describeEventStoreConformance } from '@ocoda/event-sourcing/testing';
import { createEventStore, dropEventCollections, failInsertsOf } from '../support/stores.js';

describeEventStoreConformance(MariaDBEventStore.name, async (context) => {
	const { store } = createEventStore({}, context);
	await store.connect();

	return {
		store,
		cleanup: async (collections) => {
			await dropEventCollections(store, collections);
			await store.disconnect();
		},
		faults: { failInsertOf: (collection, eventName) => failInsertsOf(store, collection, eventName) },
	};
});
