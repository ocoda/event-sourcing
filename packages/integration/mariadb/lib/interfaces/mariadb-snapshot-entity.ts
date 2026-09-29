import type { AggregateRoot, ISnapshot } from '@ocoda/event-sourcing';

/**
 * A row of a snapshot table. `registered_on` is read as UTC wall time text from a schema v2 table, and as a `Date`
 * (through the connector, like 3.x) from a 3.x table.
 */
export type MariaDBSnapshotEntity<A extends AggregateRoot> = {
	stream_id: string;
	version: number;
	payload: ISnapshot<A>;
	snapshot_id: string;
	aggregate_id: string;
	registered_on: string | Date;
	aggregate_name: string;
	latest?: string | null;
};
