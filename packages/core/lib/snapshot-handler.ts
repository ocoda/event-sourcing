import { Inject, type Type } from '@nestjs/common';
import { MissingAggregateMetadataException, MissingSnapshotMetadataException } from './exceptions';
import { getAggregateMetadata, getSnapshotMetadata } from './helpers';
import type { ISnapshotHandler } from './interfaces/aggregate/snapshot-handler.interface';
import type { ISnapshotPool } from './interfaces/aggregate/snapshot-pool.type';
import type { ISnapshot } from './interfaces/aggregate/snapshot.interface';
import { type AggregateRoot, type Id, type SnapshotEnvelope, SnapshotStream } from './models';
import { SnapshotStore } from './snapshot-store';

export abstract class SnapshotHandler<A extends AggregateRoot = AggregateRoot> implements ISnapshotHandler<A> {
	private readonly aggregate: Type<A>;
	private readonly streamName: string;
	private readonly interval: number;

	constructor(@Inject(SnapshotStore) readonly snapshotStore: SnapshotStore) {
		const { aggregate, interval } = getSnapshotMetadata<A>(this.constructor as Type<ISnapshotHandler<A>>);

		if (!(aggregate && interval)) {
			throw new MissingSnapshotMetadataException(this.constructor);
		}

		const { streamName } = getAggregateMetadata(aggregate);

		if (!streamName) {
			throw new MissingAggregateMetadataException(aggregate);
		}

		this.aggregate = aggregate;
		this.interval = interval;
		this.streamName = streamName;
	}

	async save(id: Id, aggregate: A, pool?: ISnapshotPool): Promise<void> {
		if (aggregate.version % this.interval === 0 || aggregate.version === 1) {
			const snapshotStream = SnapshotStream.for(aggregate, id);
			const payload = this.serialize(aggregate);
			await this.snapshotStore.appendSnapshot(snapshotStream, aggregate.version, payload, pool);
		}
	}

	async load(id: Id, pool?: ISnapshotPool): Promise<A> {
		const snapshotStream = SnapshotStream.for<A>(this.aggregate, id);
		const envelope = await this.snapshotStore.getLastEnvelope<A>(snapshotStream, pool);

		if (!envelope) {
			return new this.aggregate();
		}

		const aggregate = this.deserialize(envelope.payload);
		aggregate.version = envelope.metadata.version;

		return aggregate;
	}
	async *loadMany(filter?: { fromId?: Id; limit?: number; pool?: string }): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const id = filter?.fromId?.value;
		for await (const envelopes of this.snapshotStore.getLastEnvelopes<A>(this.streamName, {
			...filter,
			fromId: id,
		})) {
			yield envelopes;
		}
	}

	abstract serialize(aggregate: A): ISnapshot<A>;
	abstract deserialize(payload: ISnapshot<A>): A;
}
