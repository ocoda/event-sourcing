import type { EventStore, IEventCollection } from '@ocoda/event-sourcing';

/**
 * What a conformance suite factory hands to the suite.
 */
export interface ConformanceStoreHandle<TStore> {
	/**
	 * The connected store under test.
	 */
	store: TStore;
	/**
	 * Called once after the last test: drop the given collections (tables) and disconnect the store.
	 * The list also names collections the suite expected to never be created, so ignore those that don't exist.
	 */
	cleanup: (collections: string[]) => void | Promise<void>;
}

/**
 * Failures an event store's conformance handle can inject, for the cases that need a write to fail halfway.
 */
export interface EventStoreFaults {
	/**
	 * Makes every insert of an event with the given name into the collection fail, from inside the store's write (a
	 * trigger or a validator, not a mock), so that the rest of the append has to be undone. Resolves once the fault is
	 * in place, with a function that removes it.
	 */
	failInsertOf(collection: IEventCollection, eventName: string): Promise<() => Promise<void>>;
}

/**
 * What an event store conformance factory hands to the suite.
 */
export interface EventStoreConformanceHandle<TStore extends EventStore<unknown> = EventStore<unknown>> {
	/**
	 * The connected store under test. Its capabilities are final.
	 */
	store: TStore;
	/**
	 * Called once after the last test: drop the given collections (tables), and their catalog entries, and disconnect
	 * the store. The list also names collections the suite expected to never be created, so ignore those that don't
	 * exist.
	 */
	cleanup(collections: IEventCollection[]): void | Promise<void>;
	/**
	 * Fault injection, for the cases that need it. Without it, `append-atomic-partial-failure` fails for a store that
	 * claims `atomicAppend` (the default): provide it, or skip that case with a reason.
	 */
	faults?: EventStoreFaults;
}
