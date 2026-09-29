import type { ISnapshot, SnapshotEnvelopeMetadata } from '../interfaces/index.js';
import type { AggregateRoot } from './aggregate-root.js';
import { UUID } from './uuid.js';

export class SnapshotEnvelope<A extends AggregateRoot = AggregateRoot> {
	private constructor(
		readonly payload: ISnapshot<A>,
		readonly metadata: SnapshotEnvelopeMetadata,
	) {}

	static create<A extends AggregateRoot>(
		payload: ISnapshot<A>,
		metadata: Omit<SnapshotEnvelopeMetadata, 'snapshotId' | 'registeredOn'> & {
			snapshotId?: string;
		},
	): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(payload, {
			snapshotId: metadata.snapshotId || UUID.generate().value,
			registeredOn: new Date(),
			...metadata,
		});
	}

	static from<A extends AggregateRoot>(payload: ISnapshot<A>, metadata: SnapshotEnvelopeMetadata): SnapshotEnvelope<A> {
		return new SnapshotEnvelope(payload, metadata);
	}
}
