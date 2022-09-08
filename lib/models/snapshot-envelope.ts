import { randomUUID } from 'crypto';
import { Id } from './id';
import { ISnapshotPayload, SnapshotEnvelopeMetadata } from '../interfaces';
import { Aggregate } from './aggregate';

export class SnapshotEnvelope<A extends Aggregate = Aggregate> {
	private constructor(
		public readonly snapshotId: string,
		public readonly snapshotName: string,
		readonly payload: ISnapshotPayload<A>,
		readonly metadata: SnapshotEnvelopeMetadata,
	) {}

	static create<A extends Aggregate>(
		aggregateId: Id,
		sequence: number,
		snapshotName: string,
		payload: ISnapshotPayload<A>,
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(randomUUID(), snapshotName, payload, {
			aggregateId: aggregateId.value,
			sequence,
			registeredOn: Date.now(),
		});
	}

	static from<A extends Aggregate = Aggregate>(
		snapshotId: string,
		snapshotName: string,
		payload: ISnapshotPayload<A>,
		metadata: SnapshotEnvelopeMetadata,
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(snapshotId, snapshotName, payload, metadata);
	}
}
