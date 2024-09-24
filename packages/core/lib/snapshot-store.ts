import { Logger } from '@nestjs/common';
import type {
	EventSourcingModuleOptions,
	ILatestSnapshotFilter,
	ISnapshot,
	ISnapshotCollection,
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

	public abstract connect(): void | Promise<void>;
	public abstract disconnect(): void | Promise<void>;

	public abstract ensureCollection(pool?: ISnapshotPool): ISnapshotCollection | Promise<ISnapshotCollection>;

	abstract getSnapshots<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<ISnapshot<A>[]>;
	abstract getSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract getLastSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): ISnapshot<A> | Promise<ISnapshot<A>>;
	abstract getManyLastSnapshots<A extends AggregateRoot>(
		snapshotStreams: SnapshotStream[],
		pool?: ISnapshotPool,
	): Map<SnapshotStream, ISnapshot<A>> | Promise<Map<SnapshotStream, ISnapshot<A>>>;
	abstract appendSnapshot<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		snapshot: ISnapshot<A>,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract getLastEnvelope<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract getEnvelopes?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		filter?: ISnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;
	abstract getEnvelope?<A extends AggregateRoot>(
		snapshotStream: SnapshotStream,
		version: number,
		pool?: ISnapshotPool,
	): SnapshotEnvelope<A> | Promise<SnapshotEnvelope<A>>;
	abstract getLastEnvelopes?<A extends AggregateRoot>(
		aggregateName: string,
		filter?: ILatestSnapshotFilter,
	): AsyncGenerator<SnapshotEnvelope<A>[]>;
}
