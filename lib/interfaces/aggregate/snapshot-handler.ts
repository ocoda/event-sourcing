import { Inject, Type } from '@nestjs/common';
import { SNAPSHOT_METADATA } from '../../decorators';
import { SnapshotStore } from '../../snapshot-store';
import { Aggregate, Id, SnapshotStream } from '../../models';
import { SnapshotMetadata } from './snapshot-handler-metadata.interface';
import { ISnapshot } from './snapshot.interface';

export abstract class SnapshotHandler<A extends Aggregate = Aggregate> {
	private readonly aggregate: Type<A>;
	private readonly interval: number;

	constructor(@Inject(SnapshotStore) readonly snapshotStore: SnapshotStore) {
		const { aggregate, interval } = Reflect.getMetadata(SNAPSHOT_METADATA, this.constructor) as SnapshotMetadata<A>;

		this.aggregate = aggregate;
		this.interval = interval;
	}

	async save(id: Id, aggregate: A): Promise<void> {
		if (aggregate.version % this.interval === 0) {
			const snapshotStream = SnapshotStream.for(aggregate, id);
			const payload = this.serialize(aggregate);

			await this.snapshotStore.appendSnapshot(id, aggregate.version, snapshotStream, payload);
		}
	}

	async load(id: Id): Promise<A> {
		const snapshotStream = SnapshotStream.for<A>(this.aggregate, id);
		const snapshot = await this.snapshotStore.getLastSnapshot<A>(snapshotStream);

		if (!snapshot) {
			return new this.aggregate();
		}

		return this.deserialize(snapshot);
	}
	abstract serialize(aggregate: A): ISnapshot<A>;
	abstract deserialize(payload: ISnapshot<A>): A;
}
