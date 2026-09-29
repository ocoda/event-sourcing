import { InMemoryEventStore } from '@ocoda/event-sourcing';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';

describeEventStoreConformance(
	InMemoryEventStore.name,
	async (eventMap) => {
		const store = new InMemoryEventStore(eventMap, { driver: InMemoryEventStore });
		await store.connect();

		return { store, cleanup: () => store.disconnect() };
	},
	{
		skip: {
			// TODO: reads from an unknown pool yield nothing (getEvents, getEnvelopes, getAllEnvelopes) or throw an
			// EventNotFoundException (getEvent, getEnvelope) instead of failing like the SQL and DynamoDB stores do.
			'unknown-pool-read': 'reads from a collection that does not exist yield nothing instead of failing',
			// TODO: events are kept as serialized, so a Date in a payload is returned as the same Date instead of the
			// ISO-8601 string the SQL and DynamoDB stores return.
			'payload-dates-as-iso-strings': 'payloads are kept in memory as is, so dates stay Date instances',
		},
	},
);
