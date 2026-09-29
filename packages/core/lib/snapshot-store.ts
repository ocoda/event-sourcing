import { Logger, type Type } from '@nestjs/common';
import { UnsupportedOperationException } from './exceptions/index.js';
import type {
	EventSourcingModuleOptions,
	ILatestSnapshotFilter,
	ISnapshot,
	ISnapshotCollection,
	ISnapshotCollectionFilter,
	ISnapshotFilter,
	ISnapshotPool,
} from './interfaces/index.js';
import type { AggregateRoot, SnapshotEnvelope, SnapshotStream } from './models/index.js';

/**
 * The base class of a snapshot store. Every method returns a promise (or, for the reads that hand out batches, an
 * async generator).
 *
 * A store implements the abstract methods. `getManyLastSnapshotEnvelopes` and `getLastEnvelopesForAggregate` have
 * defaults: the first reads the streams one by one with `getLastEnvelope`, the second throws an
 * `UnsupportedOperationException`. Override them when the database can do better.
 */
export abstract class SnapshotStore<TOptions = Omit<EventSourcingModuleOptions['snapshotStore'], 'driver'>> {
	protected readonly logger = new Logger(this.constructor.name);

	constructor(protected readonly options: TOptions) {}

	/**
	 * Connect to the snapshot store
	 */
	public abstract connect(): Promise<void>;

	/**
	 * Disconnect from the snapshot store
	 */
	public abstract disconnect(): Promise<void>;

	/**
	 * Ensure a snapshot collection exists.
	 * @param pool The snapshot pool to create the collection for.
	 * @returns The snapshot collection.
	 */
	public abstract ensureCollection(pool?: ISnapshotPool): Promise<ISnapshotCollection>;

	/**
	 * List the snapshot collections.
	 * @returns The snapshot collections.
	 */
	public abstract listCollections(filter?: ISnapshotCollectionFilter): AsyncGenerator<ISnapshotCollection[]>;

	/**
	 * Get a snapshot from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param version The snapshot version.
	 * @param pool The snapshot pool.
	 * @returns The snapshot. Rejects with a `SnapshotNotFoundException` when the stream has no snapshot at that version.
	 */
	abstract getSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A>>;

	/**
	 * Get snapshots from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param filter The snapshot filter
	 * @returns The snapshots.
	 */
	abstract getSnapshots<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]>;

	/**
	 * Get the last snapshot from the snapshot stream: the one with the highest version.
	 * @param snapshotStream The snapshot stream.
	 * @param pool The snapshot pool.
	 * @returns The snapshot, or undefined when the stream has no snapshots.
	 */
	abstract getLastSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<ISnapshot<A> | void>;

	/**
	 * Get the last snapshot from multiple snapshot streams.
	 * @param snapshotStreams The snapshot streams.
	 * @param pool The snapshot pool.
	 * @returns The snapshots, keyed by the streams that have one.
	 */
	abstract getLastSnapshots<A extends AggregateRoot>(
		snapshotStreams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, ISnapshot<A>>>;

	/**
	 * Append a snapshot to the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param version The snapshot version. It has to be higher than the version of the last snapshot of the stream, or
	 * the append rejects with a `SnapshotStoreVersionConflictException`.
	 * @param snapshot The snapshot.
	 * @param pool The snapshot pool.
	 * @returns The snapshot envelope.
	 */
	abstract appendSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>>;

	/**
	 * Get the last snapshot envelope from the snapshot stream: the one with the highest version.
	 * @param snapshotStream The snapshot stream.
	 * @param pool The snapshot pool.
	 * @returns The snapshot envelope, or undefined when the stream has no snapshots.
	 */
	abstract getLastEnvelope<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A> | void>;

	/**
	 * Get the snapshot envelopes from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param filter The snapshot filter.
	 * @returns The snapshot envelopes.
	 */
	abstract getEnvelopes<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;

	/**
	 * Get a snapshot envelope from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param version The snapshot version.
	 * @param pool The snapshot pool.
	 * @returns The snapshot envelope. Rejects with a `SnapshotNotFoundException` when the stream has no snapshot at that
	 * version.
	 */
	abstract getEnvelope<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): Promise<SnapshotEnvelope<A>>;

	/**
	 * Get the last snapshot envelope of every stream of an aggregate, in descending binary order of the aggregate ids.
	 * `filter.aggregateId` is an exclusive cursor: only the streams whose aggregate id comes after it in that order are
	 * read, so the aggregate id of the last envelope of a page is the cursor of the next page.
	 *
	 * The default throws an `UnsupportedOperationException` when it's read.
	 * @param aggregate The aggregate class.
	 * @param filter The snapshot filter.
	 * @returns The snapshot envelopes.
	 */
	// oxlint-disable-next-line require-yield -- the default only throws, when it's read like every other failing read
	async *getLastEnvelopesForAggregate<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]> {
		throw new UnsupportedOperationException({
			operation: 'getLastEnvelopesForAggregate',
			component: 'snapshot store',
		});
	}

	/**
	 * Get the last snapshot envelopes from multiple snapshot streams.
	 *
	 * The default reads the streams one after the other with `getLastEnvelope`.
	 * @param snapshotStreams The snapshot streams
	 * @param pool The snapshot pool
	 * @returns The snapshot envelopes, keyed by the streams that have one.
	 */
	async getManyLastSnapshotEnvelopes<A extends AggregateRoot>(
		snapshotStreams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Promise<Map<SnapshotStream, SnapshotEnvelope<A>>> {
		const envelopes = new Map<SnapshotStream, SnapshotEnvelope<A>>();

		for (const snapshotStream of snapshotStreams) {
			const envelope = await this.getLastEnvelope<A>(snapshotStream, pool);
			if (envelope) {
				envelopes.set(snapshotStream, envelope);
			}
		}

		return envelopes;
	}
}
