import {
	EventCollection,
	type EventEnvelope,
	EventNotFoundException,
	EventStore,
	type EventStoreCapabilities,
	type EventStream,
	type IEventCollection,
	type IEventFilter,
	type IEventPool,
	type PersistOutcome,
	type PersistTarget,
} from '@ocoda/event-sourcing';
import { createTestContext } from '@ocoda/event-sourcing-testing/unit';

/**
 * A store for the tests of the `EventStore` template: the version of every stream and the outcome of every
 * `persistEvents` call are scripted, and every call of the driver methods is recorded.
 */
export class StubEventStore extends EventStore<unknown> {
	override readonly capabilities: EventStoreCapabilities = { headers: true };

	readonly persisted: [envelopes: readonly EventEnvelope[], target: PersistTarget][] = [];
	readonly headReads: [stream: EventStream, pool: IEventPool | undefined][] = [];
	readonly stored: EventEnvelope[] = [];

	/** The version `getStreamVersion` reads: a number, or a function for each call. */
	head: number | ((stream: EventStream) => unknown) = 0;

	/** The outcome of `persistEvents`: committed with positions 1, 2, ... after the last position by default. */
	outcome: (envelopes: readonly EventEnvelope[], target: PersistTarget) => unknown = (envelopes) => ({
		status: 'committed',
		positions: envelopes.map(() => ++this.lastPosition),
	});

	lastPosition = 0n;

	async connect(): Promise<void> {}

	async disconnect(): Promise<void> {}

	async ensureCollection(pool?: IEventPool): Promise<IEventCollection> {
		return EventCollection.get(pool);
	}

	async *listCollections(): AsyncGenerator<IEventCollection[]> {
		yield [EventCollection.get()];
	}

	async getStreamVersion(stream: EventStream, pool?: IEventPool): Promise<number> {
		this.headReads.push([stream, pool]);
		return (typeof this.head === 'function' ? await this.head(stream) : this.head) as number;
	}

	async getEnvelope(stream: EventStream, version: number, pool?: IEventPool): Promise<EventEnvelope> {
		const envelope = this.stored.find(
			({ metadata }) => metadata.aggregateId === stream.aggregateId && metadata.version === version,
		);
		if (!envelope) {
			throw new EventNotFoundException({ streamId: stream.streamId, version, pool });
		}
		return envelope;
	}

	async *getEnvelopes(stream: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]> {
		const envelopes = this.stored.filter(({ metadata }) => metadata.aggregateId === stream.aggregateId);
		const batch = filter?.batch || 100;
		for (let index = 0; index < envelopes.length; index += batch) {
			yield envelopes.slice(index, index + batch);
		}
	}

	protected async persistEvents(envelopes: readonly EventEnvelope[], target: PersistTarget): Promise<PersistOutcome> {
		this.persisted.push([envelopes, target]);
		const outcome = (await this.outcome(envelopes, target)) as PersistOutcome;
		if (outcome?.status === 'committed') {
			this.stored.push(...envelopes);
		}
		return outcome;
	}
}

/**
 * A stub store with a publisher spy.
 */
export const createStubStore = (capabilities?: EventStoreCapabilities) => {
	const publishAll = vi.fn(async (_envelopes: readonly EventEnvelope[]) => undefined);
	const context = { ...createTestContext(), publisher: { publishAll } };
	const store = new StubEventStore(context, {});
	if (capabilities) {
		Object.assign(store.capabilities, capabilities);
	}
	return { store, publishAll, eventMap: context.eventMap };
};
