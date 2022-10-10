import { Inject, Type } from '@nestjs/common';
import { getAggregateMetadata, getSnapshotMetadata } from '../../helpers';
import { AggregateRoot, Id, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';
import { SnapshotMetadata } from './snapshot-handler-metadata.interface';
import { ISnapshotPool } from './snapshot-pool.type';
import { ISnapshot } from './snapshot.interface';

export abstract class SnapshotHandler<A extends AggregateRoot = AggregateRoot> {
	private readonly aggregate: Type<A>;
	private readonly interval: number;

	constructor(@Inject(SnapshotStore) readonly snapshotStore: SnapshotStore) {
		const { aggregate, interval } = getSnapshotMetadata(this.constructor) as SnapshotMetadata<A>;

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
	async loadMany(aggregate: Type<A>): Promise<A[]> {
		const aggregateName = getAggregateMetadata(aggregate);
		return this.snapshotStore.getLastEnvelopes();
	}
	abstract serialize(aggregate: A): ISnapshot<A>;
	abstract deserialize(payload: ISnapshot<A>): A;
}
