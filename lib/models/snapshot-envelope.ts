import { randomUUID } from 'crypto';
import { Id } from './id';
import { ISnapshot, SnapshotEnvelopeMetadata } from '../interfaces';
import { AggregateRoot } from './aggregate-root';

export class SnapshotEnvelope<A extends AggregateRoot = AggregateRoot> {
	private constructor(
		public readonly snapshotId: string,
		readonly payload: ISnapshot<A>,
		readonly metadata: SnapshotEnvelopeMetadata,
	) {}

	static create<A extends AggregateRoot>(
		aggregateId: Id,
		sequence: number,
		payload: ISnapshot<A>,
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(randomUUID(), payload, {
			aggregateId: aggregateId.value,
			sequence,
			registeredOn: Date.now(),
		});
	}

	static from<A extends AggregateRoot = AggregateRoot>(
		snapshotId: string,
		payload: ISnapshot<A>,
		metadata: SnapshotEnvelopeMetadata,
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(snapshotId, payload, metadata);
	}
}
