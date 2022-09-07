import { Inject, Type } from '@nestjs/common';
import { SNAPSHOT_METADATA } from '../../decorators';
import { SnapshotStore } from '../../snapshot-store';
import { Aggregate, Id, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotMetadata } from './snapshot-handler-metadata.interface';
import { ISnapshot, ISnapshotPayload } from './snapshot.interface';

export abstract class SnapshotHandler<A extends Aggregate = Aggregate> {
	private readonly aggregate: Type<Aggregate>;
	private readonly snapshotName: string;
	private readonly interval: number;

	constructor(@Inject(SnapshotStore) readonly snapshotStore: SnapshotStore) {
		const { aggregate, name, interval } = Reflect.getMetadata(SNAPSHOT_METADATA, this.constructor) as SnapshotMetadata;

		this.aggregate = aggregate;
		this.snapshotName = name;
		this.interval = interval;
	}

	async save(id: Id, aggregate: A): Promise<void> {
		if (aggregate.version % this.interval === 0) {
			const snapshotStream = SnapshotStream.for(this.aggregate, id);
			const payload = this.serialize(aggregate.snapshot as ISnapshot<A>);

			await this.snapshotStore.appendSnapshots(snapshotStream, [
				SnapshotEnvelope.new(id, aggregate.version, this.snapshotName, payload),
			]);
		}
	}

	async hydrate(id: Id, aggregate: A): Promise<void> {
		const snapshotStream = SnapshotStream.for(this.aggregate, id);
		const snapshotEnvelope = await this.snapshotStore.getLastSnapshot(snapshotStream);

		if (!snapshotEnvelope) {
			return;
		}

		const { payload, metadata } = snapshotEnvelope;
		const snapshot = this.deserialize(payload as ISnapshotPayload<A>);

		aggregate.loadFromSnapshot(snapshot, metadata.sequence);
	}
	abstract serialize(snapshot: ISnapshot<A>): ISnapshotPayload<A>;
	abstract deserialize(payload: ISnapshotPayload<A>, ...params): ISnapshot<A>;
}
