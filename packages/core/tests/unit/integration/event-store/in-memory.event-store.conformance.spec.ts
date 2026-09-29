import {
	type EventEnvelope,
	type EventStoreCapabilities,
	EventStorePersistenceException,
	type IEventCollection,
	InMemoryEventStore,
	type PersistOutcome,
	type PersistTarget,
} from '@ocoda/event-sourcing';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';

/**
 * The in-memory store with the write failures the conformance suite injects: the append of an event with a failing
 * name fails before anything is stored.
 */
class FaultyInMemoryEventStore extends InMemoryEventStore {
	readonly failing = new Map<IEventCollection, Set<string>>();

	protected override async persistEvents(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		const failing = this.failing.get(target.collection);
		const poisoned = envelopes.find(({ event }) => failing?.has(event));
		if (poisoned) {
			throw new EventStorePersistenceException(
				{ collection: target.collection, outcome: 'not-persisted' },
				{ cause: new Error(`Injected failure for ${poisoned.event}`) },
			);
		}
		return super.persistEvents(envelopes, target);
	}
}

describeEventStoreConformance(
	InMemoryEventStore.name,
	async (context) => {
		const store = new FaultyInMemoryEventStore(context, { driver: InMemoryEventStore });
		await store.connect();

		return {
			store,
			cleanup: () => store.disconnect(),
			faults: {
				failInsertOf: async (collection, eventName) => {
					const failing = store.failing.get(collection) ?? new Set();
					failing.add(eventName);
					store.failing.set(collection, failing);
					return async () => {
						failing.delete(eventName);
					};
				},
			},
		};
	},
	{
		skip: {
			// TODO: events are kept as serialized, so a Date in a payload is returned as the same Date instead of the
			// ISO-8601 string the SQL stores return.
			'payload-dates-as-iso-strings': 'payloads are kept in memory as is, so dates stay Date instances',
		},
	},
);

/**
 * The in-memory store claiming only a best-effort global order, so that the case for such stores (MongoDB standalone,
 * from schema v2 on) runs here too.
 */
class BestEffortInMemoryEventStore extends InMemoryEventStore {
	override readonly capabilities: EventStoreCapabilities = {
		atomicAppend: true,
		headers: true,
		globalOrder: 'best-effort',
	};
}

describeEventStoreConformance(
	`${InMemoryEventStore.name} (best-effort global order)`,
	async (context) => {
		const store = new BestEffortInMemoryEventStore(context, { driver: InMemoryEventStore });
		await store.connect();
		return { store, cleanup: () => store.disconnect() };
	},
	{ only: ['read-all-best-effort'] },
);
