import { Inject, type Type } from '@nestjs/common';
import { MissingAggregateMetadataException, MissingSnapshotMetadataException } from './exceptions';
import { getAggregateMetadata, getSnapshotMetadata } from './helpers';
import type { ISnapshotPool, ISnapshotRepository } from './interfaces';
import type { ISnapshot } from './interfaces/aggregate/snapshot.interface';
import { type AggregateRoot, type Id, type SnapshotEnvelope, SnapshotStream } from './models';
import { SnapshotStore } from './snapshot-store';

export abstract class SnapshotRepository<A extends AggregateRoot = AggregateRoot> implements ISnapshotRepository<A> {
	private readonly aggregate: Type<A>;
	private readonly interval: number;

	constructor(@Inject(SnapshotStore) readonly snapshotStore: SnapshotStore) {
		const { aggregate, interval } = getSnapshotMetadata<A>(this.constructor as Type<ISnapshotRepository<A>>);

		if (!(aggregate && interval)) {
			throw new MissingSnapshotMetadataException(this.constructor);
		}

		const { streamName } = getAggregateMetadata(aggregate);

		if (!streamName) {
			throw new MissingAggregateMetadataException(aggregate);
		}

		this.aggregate = aggregate;
		this.interval = interval;
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

	async loadMany(ids: Id[], pool?: ISnapshotPool): Promise<A[]> {
		const snapshotStreams = ids.map((id) => SnapshotStream.for<A>(this.aggregate, id));
		const envelopes = await this.snapshotStore.getManyLastSnapshotEnvelopes<A>(snapshotStreams, pool);

		const aggregates = [];
		for (const { payload, metadata } of envelopes.values()) {
			const aggregate = this.deserialize(payload);
			aggregate.version = metadata.version;
			aggregates.push(aggregate);
		}

		return aggregates;
	}

	async *loadAll(filter?: { fromId?: Id; limit?: number; pool?: string }): AsyncGenerator<SnapshotEnvelope<A>[]> {
		const id = filter?.fromId?.value;
		for await (const envelopes of this.snapshotStore.getLastEnvelopesForAggregate<A>(this.aggregate, {
			...filter,
			fromId: id,
		})) {
			yield envelopes;
		}
	}

	abstract serialize(aggregate: A): ISnapshot<A>;
	abstract deserialize(payload: ISnapshot<A>): A;
}
