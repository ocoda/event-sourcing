import {
	Aggregate,
	AggregateRoot,
	EventSourcingErrorCode,
	type ISnapshot,
	type ISnapshotCollection,
	type ISnapshotPool,
	InMemorySnapshotStore,
	SnapshotEnvelope,
	SnapshotStore,
	type SnapshotStoreConfig,
	type SnapshotStoreDriver,
	SnapshotStream,
	UUID,
	UnsupportedOperationException,
	isEventSourcingError,
} from '@ocoda/event-sourcing';

@Aggregate({ streamName: 'minimal' })
class Minimal extends AggregateRoot {}

/**
 * A snapshot store with the abstract methods only, so it gets the defaults of the base class. The last envelopes are
 * kept per stream id.
 */
class MinimalSnapshotStore extends SnapshotStore<{ label: string }> {
	public readonly lastEnvelopes = new Map<string, SnapshotEnvelope<any>>();

	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection> {
		return `${pool ?? 'default'}-snapshots`;
	}
	async *listCollections(): AsyncGenerator<ISnapshotCollection[]> {}
	async getSnapshot<A extends AggregateRoot>(): Promise<ISnapshot<A>> {
		throw new Error('not used');
	}
	async *getSnapshots<A extends AggregateRoot>(): AsyncGenerator<ISnapshot<A>[]> {}
	async getLastSnapshot<A extends AggregateRoot>(): Promise<ISnapshot<A> | void> {}
	async getLastSnapshots<A extends AggregateRoot>(): Promise<Map<SnapshotStream, ISnapshot<A>>> {
		return new Map();
	}
	async appendSnapshot<A extends AggregateRoot>(
		stream: SnapshotStream,
		version: number,
		snapshot: ISnapshot<A>,
	): Promise<SnapshotEnvelope<A>> {
		const envelope = SnapshotEnvelope.create<A>(snapshot, { aggregateId: stream.aggregateId, version });
		this.lastEnvelopes.set(stream.streamId, envelope);
		return envelope;
	}
	async getLastEnvelope<A extends AggregateRoot>(stream: SnapshotStream): Promise<SnapshotEnvelope<A> | void> {
		return this.lastEnvelopes.get(stream.streamId);
	}
	async *getEnvelopes<A extends AggregateRoot>(): AsyncGenerator<SnapshotEnvelope<A>[]> {}
	async getEnvelope<A extends AggregateRoot>(): Promise<SnapshotEnvelope<A>> {
		throw new Error('not used');
	}
}

const newStream = () => SnapshotStream.for(Minimal, UUID.generate());

describe(SnapshotStore, () => {
	let store: MinimalSnapshotStore;

	beforeEach(() => {
		store = new MinimalSnapshotStore({ label: 'minimal' });
	});

	describe('getManyLastSnapshotEnvelopes (base default)', () => {
		it('reads the last envelope of every stream with getLastEnvelope, keyed by the streams that have one', async () => {
			const [first, withoutSnapshot, second] = [newStream(), newStream(), newStream()];
			const firstEnvelope = await store.appendSnapshot(first, 3, { n: 1 });
			const secondEnvelope = await store.appendSnapshot(second, 7, { n: 2 });
			const getLastEnvelope = vi.spyOn(store, 'getLastEnvelope');

			const envelopes = await store.getManyLastSnapshotEnvelopes([first, withoutSnapshot, second], 'tenant-1');

			expect([...envelopes.entries()]).toEqual([
				[first, firstEnvelope],
				[second, secondEnvelope],
			]);
			expect(getLastEnvelope.mock.calls).toEqual([
				[first, 'tenant-1'],
				[withoutSnapshot, 'tenant-1'],
				[second, 'tenant-1'],
			]);
		});

		it('reads the streams one after the other', async () => {
			const streams = [newStream(), newStream(), newStream()];
			let reading = 0;
			let mostAtOnce = 0;
			vi.spyOn(store, 'getLastEnvelope').mockImplementation(async () => {
				reading++;
				mostAtOnce = Math.max(mostAtOnce, reading);
				await new Promise((resolve) => setTimeout(resolve, 1));
				reading--;
			});

			await expect(store.getManyLastSnapshotEnvelopes(streams)).resolves.toEqual(new Map());
			expect(mostAtOnce).toBe(1);
		});

		it('reads nothing for no streams', async () => {
			const getLastEnvelope = vi.spyOn(store, 'getLastEnvelope');

			await expect(store.getManyLastSnapshotEnvelopes([])).resolves.toEqual(new Map());
			expect(getLastEnvelope).not.toHaveBeenCalled();
		});

		it('rejects with the error of getLastEnvelope', async () => {
			const failure = new Error('connection lost');
			vi.spyOn(store, 'getLastEnvelope').mockRejectedValue(failure);

			await expect(store.getManyLastSnapshotEnvelopes([newStream()])).rejects.toBe(failure);
		});
	});

	describe('getLastEnvelopesForAggregate (base default)', () => {
		it('rejects with an UnsupportedOperationException when it is read, not when it is called', async () => {
			const envelopes = store.getLastEnvelopesForAggregate(Minimal, { limit: 1 });

			const error = await envelopes.next().then(
				() => undefined,
				(rejection: unknown) => rejection,
			);

			expect(isEventSourcingError(error, EventSourcingErrorCode.UnsupportedOperation)).toBe(true);
			expect(error).toBeInstanceOf(UnsupportedOperationException);
			expect(error).toMatchObject({ operation: 'getLastEnvelopesForAggregate', component: 'snapshot store' });
			await expect(envelopes.next()).resolves.toEqual({ done: true, value: undefined });
		});
	});

	describe('types', () => {
		it('is Promise-only', () => {
			expectTypeOf<ReturnType<SnapshotStore['connect']>>().toEqualTypeOf<Promise<void>>();
			expectTypeOf<ReturnType<SnapshotStore['disconnect']>>().toEqualTypeOf<Promise<void>>();
			expectTypeOf<ReturnType<SnapshotStore['ensureCollection']>>().toEqualTypeOf<Promise<ISnapshotCollection>>();
			expectTypeOf(store.getSnapshot<Minimal>).returns.toEqualTypeOf<Promise<ISnapshot<Minimal>>>();
			expectTypeOf(store.getLastSnapshot<Minimal>).returns.toEqualTypeOf<Promise<ISnapshot<Minimal> | void>>();
			expectTypeOf(store.getLastSnapshots<Minimal>).returns.toEqualTypeOf<
				Promise<Map<SnapshotStream, ISnapshot<Minimal>>>
			>();
			expectTypeOf(store.appendSnapshot<Minimal>).returns.toEqualTypeOf<Promise<SnapshotEnvelope<Minimal>>>();
			expectTypeOf(store.getLastEnvelope<Minimal>).returns.toEqualTypeOf<Promise<SnapshotEnvelope<Minimal> | void>>();
			expectTypeOf(store.getEnvelope<Minimal>).returns.toEqualTypeOf<Promise<SnapshotEnvelope<Minimal>>>();
			expectTypeOf(store.getManyLastSnapshotEnvelopes<Minimal>).returns.toEqualTypeOf<
				Promise<Map<SnapshotStream, SnapshotEnvelope<Minimal>>>
			>();
			expectTypeOf(store.getEnvelopes<Minimal>).returns.toEqualTypeOf<AsyncGenerator<SnapshotEnvelope<Minimal>[]>>();
			expectTypeOf(store.getLastEnvelopesForAggregate<Minimal>).returns.toEqualTypeOf<
				AsyncGenerator<SnapshotEnvelope<Minimal>[]>
			>();
		});

		it('types a driver as the class of a snapshot store, created with its options', () => {
			expectTypeOf<SnapshotStoreDriver<{ label: string }>>().toEqualTypeOf<
				new (options: { label: string }) => SnapshotStore<{ label: string }>
			>();
			expectTypeOf(MinimalSnapshotStore).toExtend<SnapshotStoreDriver>();
			expectTypeOf(InMemorySnapshotStore).toExtend<SnapshotStoreDriver>();
			expectTypeOf<SnapshotStoreConfig['driver']>().toEqualTypeOf<SnapshotStoreDriver>();

			// A store is not a driver: the 3.x instance interface of that name is gone
			expectTypeOf(store).not.toExtend<SnapshotStoreDriver>();
		});
	});
});
