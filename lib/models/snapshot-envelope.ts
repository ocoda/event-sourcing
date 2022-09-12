import { randomUUID } from 'crypto';
import { Id } from './id';
import { ISnapshot, SnapshotEnvelopeMetadata } from '../interfaces';
import { Aggregate } from './aggregate';

export class SnapshotEnvelope<A extends Aggregate = Aggregate> {
	private constructor(
		public readonly snapshotId: string,
		readonly payload: ISnapshot<A>,
		readonly metadata: SnapshotEnvelopeMetadata,
	) {}

	static create<A extends Aggregate>(aggregateId: Id, sequence: number, payload: ISnapshot<A>): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(randomUUID(), payload, {
			aggregateId: aggregateId.value,
			sequence,
			registeredOn: Date.now(),
		});
	}

	static from<A extends Aggregate = Aggregate>(
		snapshotId: string,
		payload: ISnapshot<A>,
		metadata: SnapshotEnvelopeMetadata,
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(snapshotId, payload, metadata);
	}
}
