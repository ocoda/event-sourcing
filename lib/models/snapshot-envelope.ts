import { Id } from './id';
import { ISnapshot, SnapshotEnvelopeMetadata } from '../interfaces';
import { AggregateRoot } from './aggregate-root';

export class SnapshotEnvelope<A extends AggregateRoot = AggregateRoot> {
	private constructor(readonly payload: ISnapshot<A>, readonly metadata: SnapshotEnvelopeMetadata) {}

	static create<A extends AggregateRoot>(
		payload: ISnapshot<A>,
		metadata: Omit<SnapshotEnvelopeMetadata, 'snapshotId' | 'registeredOn'>,
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(payload, {
			snapshotId: Id.generate().value,
			registeredOn: new Date(),
			...metadata,
		});
	}

	static from<A extends AggregateRoot = AggregateRoot>(
		payload: ISnapshot<A>,
		metadata: SnapshotEnvelopeMetadata,
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(payload, metadata);
	}
}
