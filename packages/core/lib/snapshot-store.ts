import { Logger, type Type } from '@nestjs/common';
import type {
	EventSourcingModuleOptions,
	ILatestSnapshotFilter,
	ISnapshot,
	ISnapshotCollection,
	ISnapshotCollectionFilter,
	ISnapshotFilter,
	ISnapshotPool,
	SnapshotStoreDriver,
} from './interfaces';
import type { AggregateRoot, SnapshotEnvelope, SnapshotStream } from './models';

export abstract class SnapshotStore<TOptions = Omit<EventSourcingModuleOptions['snapshotStore'], 'driver'>>
	implements SnapshotStoreDriver
{
	protected readonly logger = new Logger(this.constructor.name);

	constructor(protected readonly options: TOptions) {}

	/**
	 * Connect to the snapshot store
	 */
	public abstract connect(): void | Promise<void>;

	/**
	 * Disconnect from the snapshot store
	 */
	public abstract disconnect(): void | Promise<void>;

	/**
	 * Ensure a snapshot collection exists.
	 * @param pool The snapshot pool to create the collection for.
	 * @returns The snapshot collection.
	 */
	public abstract ensureCollection(pool?: ISnapshotPool): ISnapshotCollection | Promise<ISnapshotCollection>;

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
	 * @returns The snapshot.
	 */
	abstract getSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): ISnapshot<A> | Promise<ISnapshot<A>>;

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
	 * Get the last snapshot from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param pool The snapshot pool.
	 * @returns The snapshot.
	 */
	abstract getLastSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): ISnapshot<A> | void | Promise<ISnapshot<A> | void>;

	/**
	 * Get the last snapshot from multiple snapshot streams.
	 * @param snapshotStreams The snapshot streams.
	 * @param pool The snapshot pool.
	 * @returns The snapshots.
	 */
	abstract getLastSnapshots<A extends AggregateRoot>(
		snapshotStreams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Map<SnapshotStream, ISnapshot<A>> | Promise<Map<SnapshotStream, ISnapshot<A>>>;

	/**
	 * Append a snapshot to the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param version The snapshot version.
	 * @param snapshot The snapshot.
	 * @param pool The snapshot pool.
	 * @returns The snapshot envelope.
	 */
	abstract appendSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;

	/**
	 * Get the last snapshot envelope from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param pool The snapshot pool.
	 * @returns The snapshot envelope.
	 */
	abstract getLastEnvelope<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | void | Promise<SnapshotEnvelope<A> | void>;

	/**
	 * Get the last snapshot envelopes from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param filter The snapshot filter.
	 * @returns The snapshot envelopes.
	 */
	abstract getEnvelopes?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;

	/**
	 * Get a snapshot envelope from the snapshot stream.
	 * @param snapshotStream The snapshot stream.
	 * @param version The snapshot version.
	 * @param pool The snapshot pool.
	 * @returns The snapshot envelope.
	 */
	abstract getEnvelope?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;

	/**
	 * Get the last snapshot envelopes for a specified aggregate.
	 * @param aggregate The aggregate class.
	 * @param filter The snapshot filter.
	 * @returns The snapshot envelopes.
	 */
	abstract getLastEnvelopesForAggregate?<A extends AggregateRoot>(
		aggregate: Type<A>,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;

	/**
	 * Get the last snapshot envelopes from multiple snapshot streams.
	 * @param snapshotStreams The snapshot streams
	 * @param pool The snapshot pool
	 * @returns The snapshot envelopes
	 */
	abstract getManyLastSnapshotEnvelopes?<A extends AggregateRoot>(
		snapshotStreams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Map<SnapshotStream, SnapshotEnvelope<A>> | Promise<Map<SnapshotStream, SnapshotEnvelope<A>>>;
}
