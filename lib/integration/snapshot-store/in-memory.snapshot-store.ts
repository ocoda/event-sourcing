import { SnapshotNotFoundException } from '../../exceptions';
import { StreamReadingDirection } from '../../constants';
import { Aggregate, Id, SnapshotEnvelope, SnapshotStream } from '../../models';
import { SnapshotStore } from '../../snapshot-store';
import { ISnapshot, SnapshotEnvelopeMetadata } from '../../interfaces';

export interface InMemorySnapshotEnvelopeEntity<A extends Aggregate> {
	_id: string;
	stream: string;
	payload: ISnapshot<A>;
	metadata: SnapshotEnvelopeMetadata;
}

export class InMemorySnapshotStore extends SnapshotStore {
	private snapshotCollection: Map<string, InMemorySnapshotEnvelopeEntity<any>[]> = new Map();

	getSnapshots<A extends Aggregate>(
		{ subject }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): ISnapshot<A>[] {
		let envelopes =
			this.snapshotCollection.get(subject).sort(
				({ metadata: current }, { metadata: previous }) => (previous.sequence < current.sequence ? 1 : -1),
			) || [];

		if (fromVersion) {
			const startSnapshotIndex = envelopes.findIndex(({ metadata }) => metadata.sequence === fromVersion);
			envelopes = startSnapshotIndex === -1 ? [] : envelopes.slice(startSnapshotIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			envelopes = envelopes.reverse();
		}

		return envelopes.map(({ payload }) => payload);
	}

	getSnapshot<A extends Aggregate>({ name, subject }: SnapshotStream, version: number): ISnapshot<A> {
		const entity = this.snapshotCollection.get(subject)?.find(({ metadata }) => metadata.sequence === version);

		if (!entity) {
			throw SnapshotNotFoundException.withVersion(name, version);
		}

		return entity.payload;
	}

	appendSnapshot<A extends Aggregate>(
		aggregateId: Id,
		aggregateVersion: number,
		{ name, subject }: SnapshotStream,
		snapshot: ISnapshot<A>,
	): void {
		const existingEntities = this.snapshotCollection.get(subject) || [];
		const envelope = SnapshotEnvelope.create<A>(aggregateId, aggregateVersion, snapshot);

		this.snapshotCollection.set(subject, [
			...existingEntities,
			{
				_id: envelope.snapshotId,
				stream: name,
				payload: envelope.payload,
				metadata: envelope.metadata,
			},
		]);
	}

	getLastSnapshot<A extends Aggregate>({ subject }: SnapshotStream<A>): ISnapshot<A> {
		const snapshots = this.snapshotCollection.get(subject);

		if (snapshots) {
			const { payload } = snapshots.sort(
				({ metadata: current }, { metadata: previous }) => (previous.sequence > current.sequence ? 1 : -1),
			)[0];

			return payload;
		}
	}

	getEnvelopes<A extends Aggregate>(
		{ subject }: SnapshotStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): SnapshotEnvelope<A>[] {
		let entities = this.snapshotCollection.get(subject) || [];

		if (fromVersion) {
			const startSnapshotIndex = entities.findIndex(({ metadata }) => metadata.sequence === fromVersion);
			entities = startSnapshotIndex === -1 ? [] : entities.slice(startSnapshotIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			entities = entities.reverse();
		}

		return entities.map(({ _id, payload, metadata }) => SnapshotEnvelope.from(_id, payload, metadata));
	}

	getEnvelope<A extends Aggregate>({ name, subject }: SnapshotStream, version: number): SnapshotEnvelope<A> {
		const entity = this.snapshotCollection.get(subject)?.find(({ metadata }) => metadata.sequence === version);

		if (!entity) {
			throw SnapshotNotFoundException.withVersion(name, version);
		}

		return SnapshotEnvelope.from(entity._id, entity.payload, entity.metadata);
	}
}
