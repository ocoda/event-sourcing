import { InMemorySnapshotStore, SnapshotStore } from '@ocoda/event-sourcing';
import { type SnapshotStoreConformanceCase, describeSnapshotStoreConformance } from '@ocoda/event-sourcing/testing';

const inMemorySkips: Partial<Record<SnapshotStoreConformanceCase, string>> = {
	// TODO: reads from an unknown pool yield nothing or undefined instead of failing like the SQL stores do.
	'unknown-pool-read': 'reads from a collection that does not exist yield nothing instead of failing',
	// TODO: snapshots are kept as appended, so a Date in a payload is returned as the same Date instead of the
	// ISO-8601 string the SQL stores return.
	'payload-dates-as-iso-strings': 'payloads are kept in memory as is, so dates stay Date instances',
};

describeSnapshotStoreConformance(
	InMemorySnapshotStore.name,
	async () => {
		const store = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });
		await store.connect();

		return { store, cleanup: () => store.disconnect() };
	},
	{ skip: inMemorySkips },
);

/**
 * The in-memory store without its getLastEnvelopesForAggregate: it keeps the default of the SnapshotStore base class,
 * which rejects with an UnsupportedOperationException, like a custom store that doesn't implement the read. The cases
 * of that read are skipped by capability, and the other cases leave it out.
 */
class DefaultAggregateReadsSnapshotStore extends InMemorySnapshotStore {}
Object.defineProperty(DefaultAggregateReadsSnapshotStore.prototype, 'getLastEnvelopesForAggregate', {
	value: SnapshotStore.prototype.getLastEnvelopesForAggregate,
});

describeSnapshotStoreConformance(
	`${InMemorySnapshotStore.name} (SnapshotStore default of getLastEnvelopesForAggregate)`,
	async () => {
		const store = new DefaultAggregateReadsSnapshotStore({ driver: InMemorySnapshotStore });
		await store.connect();

		return { store, cleanup: () => store.disconnect() };
	},
	{ skip: inMemorySkips },
);
