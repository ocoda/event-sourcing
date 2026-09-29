// Runs the published conformance suites of @ocoda/event-sourcing/testing against the in-memory stores of the packed
// tarball, the way a custom store author runs them against theirs. scripts/test-consumers.mjs compiles it next to
// main.ts, which checks its types against the published declarations, and runs the compiled file with Vitest's
// defaults: no config file, so no globals and no setup files. It doesn't import vitest itself: Vitest refuses
// require('vitest'), which the CommonJS build would emit, while the suites register their tests through their own
// ESM import of it.
import {
	type EventEnvelope,
	EventStorePersistenceException,
	type IEventCollection,
	InMemoryEventStore,
	InMemorySnapshotStore,
	type PersistOutcome,
	type PersistTarget,
} from '@ocoda/event-sourcing';
import { describeEventStoreConformance, describeSnapshotStoreConformance } from '@ocoda/event-sourcing/testing';

/**
 * The in-memory store with the write failure that `append-atomic-partial-failure` injects: an append with an event of
 * a failing name fails before anything is stored.
 */
class FaultyInMemoryEventStore extends InMemoryEventStore {
	readonly failing = new Map<IEventCollection, Set<string>>();

	protected override async persistEvents(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		if (envelopes.some(({ event }) => this.failing.get(target.collection)?.has(event))) {
			throw new EventStorePersistenceException({ collection: target.collection, outcome: 'not-persisted' });
		}
		return super.persistEvents(envelopes, target);
	}
}

describeEventStoreConformance(
	'InMemoryEventStore (consumer)',
	async (context) => {
		const store = new FaultyInMemoryEventStore(context, { driver: InMemoryEventStore });
		await store.connect();
		return {
			store,
			cleanup: () => store.disconnect(),
			faults: {
				failInsertOf: async (collection, eventName) => {
					const failing = store.failing.get(collection) ?? new Set<string>();
					failing.add(eventName);
					store.failing.set(collection, failing);
					return async () => {
						failing.delete(eventName);
					};
				},
			},
		};
	},
	{ skip: { 'payload-dates-as-iso-strings': 'payloads are kept in memory as is, so dates stay Date instances' } },
);

describeSnapshotStoreConformance(
	'InMemorySnapshotStore (consumer)',
	async () => {
		const store = new InMemorySnapshotStore({ driver: InMemorySnapshotStore });
		await store.connect();
		return { store, cleanup: () => store.disconnect() };
	},
	{
		skip: {
			'unknown-pool-read': 'reads from a collection that does not exist yield nothing instead of failing',
			'payload-dates-as-iso-strings': 'payloads are kept in memory as is, so dates stay Date instances',
		},
	},
);
