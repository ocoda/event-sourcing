import { Inject, Type } from '@nestjs/common';
import { SNAPSHOT_METADATA } from '../../decorators';
import { AggregateRoot, Id, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';
import { SnapshotMetadata } from './snapshot-handler-metadata.interface';
import { ISnapshotPool } from './snapshot-pool.type';
import { ISnapshot } from './snapshot.interface';

export abstract class SnapshotHandler<A extends AggregateRoot = AggregateRoot> {
	private readonly aggregate: Type<A>;
	private readonly interval: number;

	constructor(@Inject(SnapshotStore) readonly snapshotStore: SnapshotStore) {
		const { aggregate, interval } = Reflect.getMetadata(SNAPSHOT_METADATA, this.constructor) as SnapshotMetadata<A>;

		this.aggregate = aggregate;
		this.interval = interval;
	}

	async save(id: Id, aggregate: A, pool?: ISnapshotPool): Promise<void> {
		if (aggregate.version % this.interval === 0) {
			const snapshotStream = SnapshotStream.for(aggregate, id, pool);
			const payload = this.serialize(aggregate);

			await this.snapshotStore.appendSnapshot(snapshotStream, aggregate.version, payload);
		}
	}

	async load(id: Id, pool?: ISnapshotPool): Promise<A> {
		const snapshotStream = SnapshotStream.for<A>(this.aggregate, id, pool);
		const envelope = await this.snapshotStore.getLastEnvelope<A>(snapshotStream);

		if (!envelope) {
			return new this.aggregate();
		}

		const aggregate = this.deserialize(envelope.payload);
		aggregate.version = envelope.metadata.version;

		return aggregate;
	}
	abstract serialize(aggregate: A): ISnapshot<A>;
	abstract deserialize(payload: ISnapshot<A>): A;
}
