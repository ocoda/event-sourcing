import type { AggregateRoot, ISnapshot } from '@ocoda/event-sourcing';

export type PostgresSnapshotEntity<A extends AggregateRoot> = {
	stream_id: string;
	version: number;
	payload: ISnapshot<A>;
	snapshot_id: string;
	aggregate_id: string;
	registered_on: Date;
	aggregate_name: string;
	latest?: string;
};
