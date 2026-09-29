import { Inject, type Type } from '@nestjs/common';
import {
	MissingAggregateMetadataException,
	MissingSnapshotMetadataException,
	UnsupportedOperationException,
} from './exceptions/index.js';
import { getAggregateMetadata, getSnapshotMetadata } from './helpers/index.js';
import type { ISnapshot } from './interfaces/aggregate/snapshot.interface.js';
import type { ISnapshotPool, ISnapshotRepository } from './interfaces/index.js';
import { getCommittedVersions } from './models/aggregate-commit-tracker.js';
import { type AggregateRoot, type Id, type SnapshotEnvelope, SnapshotStream } from './models/index.js';
import { SnapshotStore } from './snapshot-store.js';

/**
 * Determine whether a snapshot should be taken for the given aggregate.
 *
 * When the aggregate's last `commit()` is known (and the aggregate wasn't changed since), a snapshot is taken when
 * the committed events crossed the first version or an interval boundary, so a save that jumps over a boundary
 * (e.g. from version 9 to 11 with an interval of 10) still produces a snapshot.
 * Otherwise it falls back to snapshotting at the first version and at every multiple of the interval.
 */
const isSnapshotDue = (aggregate: AggregateRoot, interval: number): boolean => {
	const { version } = aggregate;
	const committed = getCommittedVersions(aggregate);

	if (committed && committed.toVersion === version && committed.fromVersion < version) {
		const { fromVersion } = committed;
		return (fromVersion < 1 && version >= 1) || Math.floor(fromVersion / interval) < Math.floor(version / interval);
	}

	return version % interval === 0 || version === 1;
};

export abstract class SnapshotRepository<A extends AggregateRoot = AggregateRoot> implements ISnapshotRepository<A> {
	private readonly aggregate: Type<A>;
	private readonly interval: number;

	constructor(@Inject(SnapshotStore) readonly snapshotStore: SnapshotStore) {
		const { aggregate, interval } = getSnapshotMetadata<A>(this.constructor as Type<ISnapshotRepository<A>>);

		if (!(aggregate && interval)) {
			throw new MissingSnapshotMetadataException({ repository: this.constructor });
		}

		const { streamName } = getAggregateMetadata(aggregate);

		if (!streamName) {
			throw new MissingAggregateMetadataException({ aggregate });
		}

		this.aggregate = aggregate;
		this.interval = interval;
	}

	async save(id: Id, aggregate: A, pool?: ISnapshotPool): Promise<void> {
		if (isSnapshotDue(aggregate, this.interval)) {
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

	async loadMany(ids: Id[], pool?: ISnapshotPool): Promise<A[]> {
		if (!this.snapshotStore.getManyLastSnapshotEnvelopes) {
			throw new UnsupportedOperationException({
				operation: 'getManyLastSnapshotEnvelopes',
				component: 'snapshot store',
			});
		}

		const snapshotStreams = ids.map((id) => SnapshotStream.for<A>(this.aggregate, id));

		const envelopes = await this.snapshotStore.getManyLastSnapshotEnvelopes<A>(snapshotStreams, pool);

		const aggregates: A[] = [];
		for (const { payload, metadata } of envelopes.values()) {
			const aggregate = this.deserialize(payload);
			aggregate.version = metadata.version;
			aggregates.push(aggregate);
		}

		return aggregates;
	}

	async *loadAll(filter?: { aggregateId?: Id; limit?: number; pool?: string }): AsyncGenerator<SnapshotEnvelope<A>[]> {
		if (!this.snapshotStore.getLastEnvelopesForAggregate) {
			throw new UnsupportedOperationException({
				operation: 'getLastEnvelopesForAggregate',
				component: 'snapshot store',
			});
		}

		const id = filter?.aggregateId?.value;
		for await (const envelopes of this.snapshotStore.getLastEnvelopesForAggregate<A>(this.aggregate, {
			...filter,
			aggregateId: id,
		})) {
			yield envelopes;
		}
	}

	abstract serialize(aggregate: A): ISnapshot<A>;
	abstract deserialize(payload: ISnapshot<A>): A;
}
