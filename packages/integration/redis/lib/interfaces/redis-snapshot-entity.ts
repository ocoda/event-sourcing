import type { AggregateRoot } from '@ocoda/event-sourcing';
import type { ISnapshot } from '@ocoda/event-sourcing';
import type { Schema } from 'redis-om';

export type RedisSnapshotEntity<A extends AggregateRoot> = Schema<{
	id: string;
	streamId: string;
	payload: string;
	aggregateName: string;
	snapshotId: ISnapshot<A>;
	aggregateId: string;
	version: number;
	registeredOn: Date;
}>;
