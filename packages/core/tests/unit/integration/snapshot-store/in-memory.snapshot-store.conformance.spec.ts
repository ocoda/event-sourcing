import { InMemorySnapshotStore } from '@ocoda/event-sourcing';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';

describeSnapshotStoreConformance(
	InMemorySnapshotStore.name,
	async () => {
		const store = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });
		await store.connect();

		return { store, cleanup: () => store.disconnect() };
	},
	{
		skip: {
			// TODO: reads from an unknown pool yield nothing or undefined instead of failing like the SQL and DynamoDB
			// stores do.
			'unknown-pool-read': 'reads from a collection that does not exist yield nothing instead of failing',
			// TODO: snapshots are kept as appended, so a Date in a payload is returned as the same Date instead of the
			// ISO-8601 string the SQL and DynamoDB stores return.
			'payload-dates-as-iso-strings': 'payloads are kept in memory as is, so dates stay Date instances',
		},
	},
);
