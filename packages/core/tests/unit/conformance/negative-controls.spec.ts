import { setTimeout as sleep } from 'node:timers/promises';
import {
	type EventEnvelope,
	type EventStoreContext,
	EventStorePersistenceException,
	type IEventCollection,
	InMemoryEventStore,
	type InMemoryEventEntity,
	type PersistOutcome,
	type PersistTarget,
} from '@ocoda/event-sourcing';
import {
	type EventStoreConformanceCase,
	type EventStoreConformanceHandle,
	describeEventStoreConformance,
} from '@ocoda/event-sourcing-testing/conformance';

// Negative controls: deliberately broken in-memory stores that the conformance cases must catch. Each suite registers
// only the case that detects the defect, as a test that must fail, which proves that the case detects it.

const toEntity = (
	{ stream }: PersistTarget,
	{ event, payload, metadata }: EventEnvelope,
	globalPosition: bigint,
): InMemoryEventEntity => ({ streamId: stream.streamId, event, payload, ...metadata, globalPosition });

/**
 * Hands out the positions of an append when it starts, but commits odd appends later than even ones, so that a later
 * position can become readable before an earlier one: the global order is not gap-safe, though the store claims it.
 */
class ReorderCommitEventStore extends InMemoryEventStore {
	private appends = 0;

	protected override async persistEvents(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		const entities = this.entitiesOf(target.pool);
		let position = this.lastPositions.get(target.collection) ?? 0n;
		const positions = envelopes.map(() => ++position);
		this.lastPositions.set(target.collection, position);

		await sleep(this.appends++ % 2 === 1 ? 20 : 0);

		// Inserted in position order, like an index would hold them
		for (const [index, envelope] of envelopes.entries()) {
			const at = entities.findIndex(({ globalPosition }) => (globalPosition as bigint) > positions[index]);
			entities.splice(at === -1 ? entities.length : at, 0, toEntity(target, envelope, positions[index]));
		}
		return { status: 'committed', positions };
	}
}

/**
 * Stores the events of an append one by one, so that a failing insert leaves the events before it: the append is not
 * atomic, though the store claims it.
 */
class NonAtomicEventStore extends InMemoryEventStore {
	readonly failing = new Map<IEventCollection, Set<string>>();

	protected override async persistEvents(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		const entities = this.entitiesOf(target.pool);
		const positions: bigint[] = [];
		for (const envelope of envelopes) {
			if (this.failing.get(target.collection)?.has(envelope.event)) {
				throw new EventStorePersistenceException(
					{ collection: target.collection, outcome: 'not-persisted' },
					{ cause: new Error(`Injected failure for ${envelope.event}`) },
				);
			}
			const position = (this.lastPositions.get(target.collection) ?? 0n) + 1n;
			this.lastPositions.set(target.collection, position);
			entities.push(toEntity(target, envelope, position));
			positions.push(position);
		}
		return { status: 'committed', positions };
	}
}

/**
 * Stores every append without checking the unique (stream, version) key, so that concurrent appends that all passed
 * the version check are all stored.
 */
class LostUniquenessEventStore extends InMemoryEventStore {
	protected override async persistEvents(
		envelopes: readonly EventEnvelope[],
		target: PersistTarget,
	): Promise<PersistOutcome> {
		const entities = this.entitiesOf(target.pool);
		let position = this.lastPositions.get(target.collection) ?? 0n;
		const positions = envelopes.map(() => ++position);
		this.lastPositions.set(target.collection, position);
		entities.push(...envelopes.map((envelope, index) => toEntity(target, envelope, positions[index])));
		return { status: 'committed', positions };
	}
}

const negativeControl = (
	name: string,
	createStore: (context: EventStoreContext) => InMemoryEventStore,
	cases: EventStoreConformanceCase[],
	faults?: (store: InMemoryEventStore) => EventStoreConformanceHandle['faults'],
) =>
	describeEventStoreConformance(
		`${name} (negative control)`,
		async (context) => {
			const store = createStore(context);
			await store.connect();
			return { store, cleanup: () => store.disconnect(), faults: faults?.(store) };
		},
		{ only: cases, expectFailure: true },
	);

negativeControl('reorder-commit', (context) => new ReorderCommitEventStore(context, { driver: InMemoryEventStore }), [
	'read-all-gap-safe',
]);

negativeControl(
	'non-atomic',
	(context) => new NonAtomicEventStore(context, { driver: InMemoryEventStore }),
	['append-atomic-partial-failure'],
	(store) => ({
		failInsertOf: async (collection, eventName) => {
			const { failing } = store as NonAtomicEventStore;
			const names = failing.get(collection) ?? new Set();
			names.add(eventName);
			failing.set(collection, names);
			return async () => {
				names.delete(eventName);
			};
		},
	}),
);

negativeControl(
	'lost-uniqueness',
	(context) => new LostUniquenessEventStore(context, { driver: InMemoryEventStore }),
	['conflict-concurrent-appends'],
);
