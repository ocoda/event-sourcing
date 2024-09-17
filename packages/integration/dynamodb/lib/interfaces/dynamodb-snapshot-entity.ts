import { AggregateRoot, ISnapshot } from '@ocoda/event-sourcing';

export interface DynamoSnapshotEntity<A extends AggregateRoot> {
	streamId: string;
	version: number;
	payload: ISnapshot<A>;
	snapshotId: string;
	aggregateId: string;
	registeredOn: number;
	aggregateName: string;
	latest?: string;
}
